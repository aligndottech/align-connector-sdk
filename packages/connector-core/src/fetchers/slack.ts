import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchOneOptions, FetchResult, FetchSkip, FetchOneResult } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';
import { FetcherAuthError } from './errors.js';
import { buildFetchReport, refusedRead } from './util/report.js';
import { budgetSpent } from './util/since.js';
import { parseWindow } from './util/time.js';
import { fetchOneInit, guardFetchOne, jsonOrThrow, parseUrl, shapeSkip, urlForDetail, vendorMessage, vendorUrl } from './util/single.js';
import { normaliseSourceKey } from '../sourceKey.js';

/** A Slack `ok:false` answer, carrying its error code so a caller can classify it. */
class SlackApiError extends Error {
  constructor(
    readonly endpoint: string,
    readonly code: string,
  ) {
    super(`Slack API error on ${endpoint}: ${code}`);
    this.name = 'SlackApiError';
  }
}

async function slackGet(
  endpoint: string,
  token: string,
  params: Record<string, string> = {},
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params);
  const url = `https://slack.com/api/${endpoint}?${qs}`;
  const headers = { Authorization: `Bearer ${token}` };
  // With a signal this is a fetchOne read: bounded, no redirects, capped body.
  const data = (signal ? await jsonOrThrow(await fetch(url, fetchOneInit(headers, signal))) : await (await fetch(url, { headers })).json()) as Record<
    string,
    unknown
  >;
  if (!data.ok) {
    // Slack answers HTTP 200 with ok:false and an error code; these codes are its 401.
    const code = String(data.error);
    if (SLACK_AUTH_ERRORS.has(code)) throw new FetcherAuthError('Slack', code);
    throw new SlackApiError(endpoint, code);
  }
  return data;
}

/** Codes meaning this token cannot see the channel: for a single capture, an `auth` skip. */
const SLACK_NO_ACCESS = new Set(['channel_not_found', 'not_in_channel', 'missing_scope', 'access_denied']);

/** Slack's error codes that mean the token itself was refused (its documented auth family). */
const SLACK_AUTH_ERRORS = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);

interface SlackMessage {
  ts: string;
  text?: string;
  reply_count?: number;
  /** On a thread root: the ts of its newest reply. */
  latest_reply?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
}

interface SlackChannel {
  id: string;
  name: string;
}

/**
 * Bounds, every one overridable through opts so tests never sleep and a large
 * workspace can be widened deliberately. Each one, when it fires, becomes a line
 * the user reads in the fetch report - a cap nobody is told about is
 * indistinguishable from a thin tool (ALI-828).
 *
 * The numbers are derived, not measured: 200 channels at the 3-second Tier-2
 * delay is 10 minutes of sleeping on its own, and 8 minutes is what the 15-minute
 * `align setup --local` budget leaves for Slack once the other sources are paid
 * for. The reference workspace (61 channels) reaches neither.
 */
const SLACK_MAX_CHANNELS = 200;
const SLACK_MAX_HISTORY_PAGES = 5; // ~5,000 messages inside the daysBack window
const SLACK_MAX_REPLY_PAGES = 3; // ~3,000 messages in one thread

/**
 * Page sizes at each endpoint's documented maximum: "under 1000" for list and
 * history, 1000 (the default and the max) for replies. 0.5.0 sent
 * conversations.replies with no limit, so a thread of up to 1000 messages came
 * back in one call; a smaller page here would cut a KEPT thread at
 * maxReplyPages and move its bytes, which the golden contract forbids. Slack's
 * 2025 15-object cap applies only to commercially distributed non-Marketplace
 * apps; a user's own app, which is what the CLI token belongs to, is exempt.
 */
const SLACK_LIST_PAGE_SIZE = 999;
const SLACK_HISTORY_PAGE_SIZE = 999;
const SLACK_REPLIES_PAGE_SIZE = 1000;
const SLACK_TIME_BUDGET_MS = 8 * 60_000;

/**
 * Message subtypes that are the WORKSPACE talking, not a person: joins, leaves,
 * topic changes, pins, and app output. A thread made only of these is machinery,
 * and on the Align demo workspace 35 of 39 captured "threads" were exactly that -
 * a tombstone root under the Align app's own replies (ALI-828).
 *
 * A closed denylist rather than "any subtype at all": `thread_broadcast` is a
 * human reply that was also posted to the channel, and `file_share` is a human
 * sharing a file with a comment. Both are decision content and both carry a
 * subtype. Every member here has its own case in fetchers.slack.test.ts.
 */
const SYSTEM_SUBTYPES = new Set([
  'bot_message',
  'tombstone',
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'pinned_item',
  'unpinned_item',
  'bot_add',
  'bot_remove',
  'reminder_add',
  'group_topic',
  'group_purpose',
  'group_name',
  'group_archive',
  'group_unarchive',
  'channel_convert_to_private',
  'channel_convert_to_public',
  'channel_posting_permissions',
  'ekm_access_denied',
]);

/**
 * A message a person wrote. `bot_id` catches an app posting AS a user (which
 * carries no subtype at all), and a message with no `user` has nobody to
 * attribute it to.
 *
 * Deliberately not "is this the Align bot": the CLI's Slack path uses a user
 * token, whose `auth.test` names the HUMAN, so an identity filter would delete
 * the user's own messages. The shape test catches Align's bot as one member of
 * the class of all bots, and stays vendor-neutral.
 */
function isHumanMessage(m: SlackMessage): boolean {
  if (m.bot_id) return false;
  // A fired /remind or a Slackbot reply carries no bot_id and no subtype, only this user.
  if (m.user === 'USLACKBOT') return false;
  if (m.subtype && SYSTEM_SUBTYPES.has(m.subtype)) return false;
  return Boolean(m.user);
}

/**
 * Follow `response_metadata.next_cursor` for up to `maxPages` pages, or until
 * `enough(rows)` says to stop. `truncated` is true when a cursor was still there
 * when paging stopped, which is the fact the report needs: rows exist that this
 * read did not see.
 */
async function slackPaged<T>(
  endpoint: string,
  token: string,
  params: Record<string, string>,
  rowsKey: 'channels' | 'messages',
  maxPages: number,
  enough: (rows: T[]) => boolean = () => false,
  signal?: AbortSignal,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const data = await slackGet(endpoint, token, { ...params, ...(cursor ? { cursor } : {}) }, signal);
    rows.push(...((data[rowsKey] as T[] | undefined) ?? []));
    pages += 1;
    cursor = (data.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
    if (!cursor) return { rows, truncated: false };
    if (enough(rows) || pages >= maxPages) return { rows, truncated: true };
  }
}

/** Resolve a Slack user id to a display name (cached - one users.info call per unique user). */
function makeUserResolver(token: string, signal?: AbortSignal) {
  const cache = new Map<string, { name: string; handle?: string; email?: string } | null>();
  return async (userId: string | undefined): Promise<{ name: string; handle?: string; email?: string } | undefined> => {
    if (!userId) return undefined;
    if (cache.has(userId)) return cache.get(userId) ?? undefined;
    try {
      const data = await slackGet('users.info', token, { user: userId }, signal);
      const u = (data.user ?? {}) as {
        name?: string;
        real_name?: string;
        profile?: { real_name?: string; display_name?: string; email?: string };
      };
      const name = u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || userId;
      const resolved = {
        name,
        ...(u.name ? { handle: u.name } : {}),
        ...(u.profile?.email ? { email: u.profile.email } : {}),
      };
      cache.set(userId, resolved);
      return resolved;
    } catch {
      cache.set(userId, null); // don't retry a failed lookup
      return undefined;
    }
  };
}

/** Dedupe by ts: Slack does not say whether a cursor page of replies carries the parent
 *  again, and a repeated root would double its text. */
function uniqueByTs(rows: SlackMessage[]): SlackMessage[] {
  const seen = new Set<string>();
  const out: SlackMessage[] = [];
  for (const m of rows) {
    if (seen.has(m.ts)) continue;
    seen.add(m.ts);
    out.push(m);
  }
  return out;
}

/**
 * One thread as an item, or undefined when no person spoke in it. The ONE mapper for
 * the list read, hot threads and fetchOne. `rootTs` names the thread (its URL and date);
 * `updated_at` is the newest message read, so a new reply moves the watermark.
 */
async function slackThreadItem(
  channel: SlackChannel,
  rootTs: string,
  messages: SlackMessage[],
  resolveUser: (id: string | undefined) => Promise<{ name: string; handle?: string; email?: string } | undefined>,
): Promise<FetcherItem | undefined> {
  // The thread's identity comes from the first HUMAN message: a deleted or bot root has
  // no title and nobody to attribute, but the conversation under it may be entirely real.
  const firstHuman = messages.find(isHumanMessage);
  if (!firstHuman) return undefined;
  // Every fetched message, bot replies included: a bot reply inside a human thread is
  // often the CI output being discussed.
  const text = messages.map((m) => m.text ?? '').join('\n');
  const author = await resolveUser(firstHuman.user);
  // The root's ts: epoch seconds with microseconds, so the thread is dated by when it started.
  const createdAt = toIsoOrUndefined(Number(rootTs) * 1000);
  const newest = Math.max(...messages.map((m) => Number(m.ts)).filter((n) => Number.isFinite(n)));
  const updatedAt = Number.isFinite(newest) ? toIsoOrUndefined(newest * 1000) : undefined;
  const sourceUrl = `https://slack.com/archives/${channel.id}/p${rootTs.replace('.', '')}`;
  const sourceKey = normaliseSourceKey('slack', sourceUrl);
  return {
    source_url: sourceUrl,
    platform: 'slack',
    raw_text: `[#${channel.name}] Thread:\n${text}`,
    title: (firstHuman.text ?? `Thread in #${channel.name}`).slice(0, 80),
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(sourceKey ? { source_key: sourceKey } : {}),
    ...(author ? { author } : {}),
  };
}

/** Channel id and thread-root ts from a message permalink, else undefined. A reply's
 *  permalink names its thread in `thread_ts`; the thread is the item. */
function parsePermalink(url: string): { channel: string; ts: string } | undefined {
  // Requests go to slack.com/api whatever the link's workspace host, but the link is still
  // held to the vendor rules (https, no userinfo or port, a slack.com host).
  const host = parseUrl(url)?.hostname.toLowerCase();
  if (!host || (host !== 'slack.com' && !host.endsWith('.slack.com'))) return undefined;
  const u = vendorUrl(url, [host]);
  if (!u) return undefined;
  const m = /^\/archives\/([A-Z0-9]+)\/p(\d{16})\/?$/.exec(u.pathname);
  if (!m) return undefined;
  const threadTs = u.searchParams.get('thread_ts');
  const ts = threadTs && /^\d{10}\.\d{6}$/.test(threadTs) ? threadTs : `${m[2]!.slice(0, 10)}.${m[2]!.slice(10)}`;
  return { channel: m[1]!, ts };
}

/**
 * Read-only personal Slack fetcher: threaded conversations (>=2 replies) the
 * token can see, within `daysBack`, that hold at least one HUMAN message. Title
 * and author come from the first human message, so a thread whose root was
 * deleted or posted by a bot is still captured when a person spoke in it, and a
 * thread made only of bot and system output is not captured at all.
 *
 * Channels, history and replies are all paged. Every bound (`maxChannels`,
 * `maxHistoryPages`, `maxReplyPages`, `timeBudgetMs`) and every filter that
 * fires is counted into the fetch report, so a thin result comes with its
 * reason. A delay between channels keeps under Slack's Tier-2 rate limit
 * (override via `interChannelDelayMs`).
 */
export class SlackFetcher implements ConnectorFetcher {
  /**
   * Capture one thread by permalink: `conversations.info` for the channel name, then one
   * `conversations.replies` read of the thread (plus the author lookup). A channel the
   * token cannot see is an `auth` skip. Never throws.
   */
  async fetchOne(url: string, opts: FetchOneOptions): Promise<FetchOneResult> {
    const link = parsePermalink(url);
    if (!link) return shapeSkip(`Slack URL not read: not a message permalink on a slack.com host: ${urlForDetail(url)}`);
    const maxReplyPages = (opts.maxReplyPages as number | undefined) ?? SLACK_MAX_REPLY_PAGES;
    return guardFetchOne('Slack', opts.timeoutMs, async (signal) => {
      try {
        const info = await slackGet('conversations.info', opts.token, { channel: link.channel }, signal);
        const channel = { id: link.channel, name: (info.channel as { name?: string } | undefined)?.name ?? link.channel };
        const replies = await slackPaged<SlackMessage>(
          'conversations.replies',
          opts.token,
          { channel: link.channel, ts: link.ts, limit: String(SLACK_REPLIES_PAGE_SIZE) },
          'messages',
          maxReplyPages,
          () => false,
          signal,
        );
        const item = await slackThreadItem(channel, link.ts, uniqueByTs(replies.rows), makeUserResolver(opts.token, signal));
        if (!item) return { skip: { kind: 'shape', count: 1, detail: `Slack thread has no human message (bot or system output only): ${urlForDetail(url)}` } };
        if (!replies.truncated) return { item };
        return {
          item: { ...item, partial: true },
          skips: [{ kind: 'page_cap', count: 1, detail: `thread replies cut at ${maxReplyPages} page(s) (raise maxReplyPages)` }],
        };
      } catch (e) {
        if (e instanceof SlackApiError && SLACK_NO_ACCESS.has(e.code)) {
          return { skip: { kind: 'auth', count: 1, detail: `Slack token cannot read this channel (${vendorMessage(e.code)})` } };
        }
        throw e;
      }
    });
  }

  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
    const limit = opts.limit ?? 50;
    const daysBack = (opts.daysBack as number | undefined) ?? 90;
    const delayMs = (opts.interChannelDelayMs as number | undefined) ?? 3000;
    const maxChannels = (opts.maxChannels as number | undefined) ?? SLACK_MAX_CHANNELS;
    const maxHistoryPages = (opts.maxHistoryPages as number | undefined) ?? SLACK_MAX_HISTORY_PAGES;
    const maxReplyPages = (opts.maxReplyPages as number | undefined) ?? SLACK_MAX_REPLY_PAGES;
    const timeBudgetMs = (opts.timeBudgetMs as number | undefined) ?? SLACK_TIME_BUDGET_MS;
    const startedAt = Date.now();
    // `oldest` bounds conversations.history by the thread ROOT's ts, so a reply added
    // today to a thread whose root is older than the window is not seen by the channel
    // walk. `complete: true` means "every root in the window was read", not "every
    // reply". `hotThreads` is the remedy: the caller names threads it already holds and
    // their replies since `since` are re-read below.
    // `since` wins over daysBack, which stays as the fallback window.
    const win = parseWindow(opts.since as string | undefined, opts.until as string | undefined);
    if (!win.ok) return refusedRead({ platform: 'slack', requested: limit, scope: 'team', detail: win.detail });
    const sinceS = win.sinceMs === undefined ? undefined : Math.floor(win.sinceMs / 1000);
    const oldest = String(sinceS ?? Math.floor(startedAt / 1000) - daysBack * 86400);
    // `until` is exclusive. History's `latest` is rounded UP to the next whole second so a
    // sub-second until never under-reads; every message at or after `until` (roots,
    // replies, hot-thread replies) is then dropped here by its own ts.
    const untilMs = win.untilMs;
    const latest = untilMs === undefined ? undefined : String(Math.ceil(untilMs / 1000));
    const beforeUntil = (m: SlackMessage) => untilMs === undefined || Number(m.ts) * 1000 < untilMs;
    const hotThreads = (opts.hotThreads as Array<{ channel: string; ts: string }> | undefined) ?? [];

    await slackGet('auth.test', opts.token);

    // Read list pages until one shows MORE channels than the cap, so the report
    // can name the surplus it saw rather than "some". At most one page past the
    // cap is read, and a cursor left after that means the surplus is a floor.
    const list = await slackPaged<SlackChannel>(
      'conversations.list',
      opts.token,
      { types: 'public_channel,private_channel', exclude_archived: 'true', limit: String(SLACK_LIST_PAGE_SIZE) },
      'channels',
      Number.POSITIVE_INFINITY,
      (rows) => rows.length > maxChannels,
    );
    const channels = list.rows.slice(0, maxChannels);
    const channelSurplus = list.rows.length - channels.length;

    const resolveUser = makeUserResolver(opts.token);
    const items: FetcherItem[] = [];
    let threadsScanned = 0;
    let shortMessages = 0;
    let noHumanThreads = 0;
    let historyCut = 0;
    let repliesCut = 0;
    let channelsUnreadable = 0;
    let threadsUnreadable = 0;
    let channelsOutOfTime = 0;
    let channelsHistoryRead = 0;
    let hotOutOfTime = 0;
    const threadsRead = new Set<string>();
    // The item limit leaving a channel or thread unread. Not a skip line (the caller set
    // the limit), but the read is not complete.
    let cutByLimit = false;

    for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
      const channel = channels[channelIndex];
      if (items.length >= limit) {
        cutByLimit = true;
        break;
      }
      if (channelIndex > 0) {
        // Checked BEFORE paying the delay: the budget bounds the loop, not the sleep.
        if (Date.now() - startedAt > timeBudgetMs) {
          channelsOutOfTime = channels.length - channelIndex;
          break;
        }
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      }
      try {
        const hist = await slackPaged<SlackMessage>(
          'conversations.history',
          opts.token,
          { channel: channel.id, oldest, ...(latest ? { latest } : {}), limit: String(SLACK_HISTORY_PAGE_SIZE) },
          'messages',
          maxHistoryPages,
        );
        channelsHistoryRead += 1;
        if (hist.truncated) historyCut += 1;
        const roots = hist.rows.filter(beforeUntil);
        const threads = roots.filter((m) => (m.reply_count ?? 0) >= 2);
        shortMessages += roots.length - threads.length;

        for (const thread of threads) {
          if (items.length >= limit) {
            cutByLimit = true;
            break;
          }
          // A root whose newest reply predates `since` has nothing new: skip its replies
          // call (roots carry latest_reply). Unknown latest_reply is read, never guessed.
          const latest = Number(thread.latest_reply);
          if (sinceS !== undefined && thread.latest_reply !== undefined && Number.isFinite(latest) && latest < sinceS) continue;
          threadsScanned += 1;
          threadsRead.add(`${channel.id}:${thread.ts}`);
          try {
            const replies = await slackPaged<SlackMessage>(
              'conversations.replies',
              opts.token,
              { channel: channel.id, ts: thread.ts, limit: String(SLACK_REPLIES_PAGE_SIZE) },
              'messages',
              maxReplyPages,
            );
            // A truncated thread is still an item; dropping it would lose the
            // decision to protect a byte count. The truncation is reported instead.
            if (replies.truncated) repliesCut += 1;
            const item = await slackThreadItem(channel, thread.ts, uniqueByTs(replies.rows).filter(beforeUntil), resolveUser);
            if (!item) {
              noHumanThreads += 1; // machinery, not a conversation
              continue;
            }
            items.push(replies.truncated ? { ...item, partial: true } : item);
          } catch {
            threadsUnreadable += 1;
          }
        }
      } catch {
        channelsUnreadable += 1;
      }
    }

    // Hot threads: threads the caller already holds whose roots may be older than the
    // window. Re-read with `oldest = since`, so only replies since then come back; a
    // thread with nothing at or after `since` yields no item. Note for the consumer: the
    // item's raw_text then holds the new messages (and the root, if Slack includes it),
    // not the whole thread, so it is marked `partial` and must be merged, not replaced.
    const channelNames = new Map(channels.map((c) => [c.id, c.name]));
    for (let hi = 0; hi < hotThreads.length; hi++) {
      const hot = hotThreads[hi]!;
      if (items.length >= limit) {
        cutByLimit = true;
        break;
      }
      if (threadsRead.has(`${hot.channel}:${hot.ts}`)) continue; // read whole by the walk above
      if (budgetSpent(startedAt, timeBudgetMs)) {
        hotOutOfTime = hotThreads.length - hi;
        break;
      }
      threadsScanned += 1;
      try {
        const replies = await slackPaged<SlackMessage>(
          'conversations.replies',
          opts.token,
          { channel: hot.channel, ts: hot.ts, limit: String(SLACK_REPLIES_PAGE_SIZE), ...(sinceS !== undefined ? { oldest: String(sinceS) } : {}) },
          'messages',
          maxReplyPages,
        );
        if (replies.truncated) repliesCut += 1;
        const rows = uniqueByTs(replies.rows).filter(beforeUntil);
        if (sinceS !== undefined && !rows.some((m) => Number(m.ts) >= sinceS)) continue; // nothing new
        const channel = { id: hot.channel, name: channelNames.get(hot.channel) ?? hot.channel };
        const item = await slackThreadItem(channel, hot.ts, rows, resolveUser);
        if (!item) {
          noHumanThreads += 1;
          continue;
        }
        items.push({ ...item, partial: true }); // only the messages since `since`: merge, never replace
      } catch {
        threadsUnreadable += 1;
      }
    }

    // A fixed order, so two runs over the same workspace print the same report.
    const skips: FetchSkip[] = [];
    if (shortMessages > 0) {
      skips.push({ kind: 'shape', count: shortMessages, detail: 'messages with fewer than 2 replies (this fetcher reads threads only)' });
    }
    if (noHumanThreads > 0) {
      skips.push({ kind: 'shape', count: noHumanThreads, detail: 'threads with no human message (bot or system output only)' });
    }
    if (channelSurplus > 0) {
      skips.push({
        kind: 'page_cap',
        count: channelSurplus,
        detail: `${list.truncated ? 'or more ' : ''}channels not scanned (the first ${maxChannels} were; raise maxChannels)`,
      });
    }
    if (historyCut > 0) {
      skips.push({
        kind: 'page_cap',
        count: historyCut,
        detail: `channels whose history was cut at ${maxHistoryPages} page(s), of ${channelsHistoryRead} channels read (raise maxHistoryPages)`,
      });
    }
    if (repliesCut > 0) {
      skips.push({ kind: 'page_cap', count: repliesCut, detail: `threads whose replies were cut at ${maxReplyPages} page(s) (raise maxReplyPages)` });
    }
    if (channelsOutOfTime > 0) {
      skips.push({
        kind: 'time_budget',
        count: channelsOutOfTime,
        detail: `channels not scanned (the ${Math.round(timeBudgetMs / 60_000)} minute Slack time budget ran out)`,
      });
    }
    if (hotOutOfTime > 0) {
      skips.push({ kind: 'time_budget', count: hotOutOfTime, detail: `hot threads not re-read (the ${Math.round(timeBudgetMs / 60_000)} minute Slack time budget ran out)` });
    }
    if (channelsUnreadable > 0) {
      skips.push({ kind: 'error', count: channelsUnreadable, detail: 'channels the token could not read' });
    }
    if (threadsUnreadable > 0) {
      skips.push({ kind: 'error', count: threadsUnreadable, detail: 'threads whose replies could not be read' });
    }

    return {
      items,
      report: buildFetchReport(items, {
        platform: 'slack',
        scanned: threadsScanned,
        requested: limit,
        skips,
        scope: 'team',
        untilMs,
        exhausted: !cutByLimit,
      }),
    };
  }
}
