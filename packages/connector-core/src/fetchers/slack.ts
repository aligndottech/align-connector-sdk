import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchResult, FetchSkip } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';

async function slackGet(
  endpoint: string,
  token: string,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${endpoint}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!data.ok) throw new Error(`Slack API error on ${endpoint}: ${data.error as string}`);
  return data;
}

interface SlackMessage {
  ts: string;
  text?: string;
  reply_count?: number;
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
const SLACK_PAGE_SIZE = 100;
const SLACK_MAX_CHANNELS = 200;
const SLACK_MAX_HISTORY_PAGES = 5; // 500 messages inside the daysBack window
const SLACK_MAX_REPLY_PAGES = 3; // 300 messages in one thread
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
  'bot_add',
  'bot_remove',
  'reminder_add',
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
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let cursor: string | undefined;
  let pages = 0;
  for (;;) {
    const data = await slackGet(endpoint, token, { ...params, ...(cursor ? { cursor } : {}) });
    rows.push(...((data[rowsKey] as T[] | undefined) ?? []));
    pages += 1;
    cursor = (data.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
    if (!cursor) return { rows, truncated: false };
    if (enough(rows) || pages >= maxPages) return { rows, truncated: true };
  }
}

/** Resolve a Slack user id to a display name (cached - one users.info call per unique user). */
function makeUserResolver(token: string) {
  const cache = new Map<string, { name: string; handle?: string; email?: string } | null>();
  return async (userId: string | undefined): Promise<{ name: string; handle?: string; email?: string } | undefined> => {
    if (!userId) return undefined;
    if (cache.has(userId)) return cache.get(userId) ?? undefined;
    try {
      const data = await slackGet('users.info', token, { user: userId });
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
    const oldest = String(Math.floor(startedAt / 1000) - daysBack * 86400);

    await slackGet('auth.test', opts.token);

    // Read list pages until one shows MORE channels than the cap, so the report
    // can name the surplus it saw rather than "some". At most one page past the
    // cap is read, and a cursor left after that means the surplus is a floor.
    const list = await slackPaged<SlackChannel>(
      'conversations.list',
      opts.token,
      { types: 'public_channel,private_channel', exclude_archived: 'true', limit: String(SLACK_PAGE_SIZE) },
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

    for (let channelIndex = 0; channelIndex < channels.length; channelIndex++) {
      const channel = channels[channelIndex];
      if (items.length >= limit) break;
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
          { channel: channel.id, oldest, limit: String(SLACK_PAGE_SIZE) },
          'messages',
          maxHistoryPages,
        );
        if (hist.truncated) historyCut += 1;
        const threads = hist.rows.filter((m) => (m.reply_count ?? 0) >= 2);
        shortMessages += hist.rows.length - threads.length;

        for (const thread of threads) {
          if (items.length >= limit) break;
          threadsScanned += 1;
          try {
            const replies = await slackPaged<SlackMessage>(
              'conversations.replies',
              opts.token,
              { channel: channel.id, ts: thread.ts, limit: String(SLACK_PAGE_SIZE) },
              'messages',
              maxReplyPages,
            );
            // A truncated thread is still an item; dropping it would lose the
            // decision to protect a byte count. The truncation is reported instead.
            if (replies.truncated) repliesCut += 1;
            const allMsgs = replies.rows;
            // The thread's identity comes from the first HUMAN message: a deleted or
            // bot root has no title and nobody to attribute, but the conversation
            // under it may be entirely real.
            const firstHuman = allMsgs.find(isHumanMessage);
            if (!firstHuman) {
              noHumanThreads += 1; // machinery, not a conversation
              continue;
            }

            // Every fetched message, bot replies included: a bot reply inside a human
            // thread is often the CI output being discussed.
            const text = allMsgs.map((m) => m.text ?? '').join('\n');
            const author = await resolveUser(firstHuman.user);
            // The root's ts: epoch seconds with microseconds, so the thread is dated by when it started.
            const createdAt = toIsoOrUndefined(Number(thread.ts) * 1000);
            items.push({
              source_url: `https://slack.com/archives/${channel.id}/p${thread.ts.replace('.', '')}`,
              platform: 'slack',
              raw_text: `[#${channel.name}] Thread:\n${text}`,
              title: (firstHuman.text ?? `Thread in #${channel.name}`).slice(0, 80),
              ...(createdAt ? { created_at: createdAt } : {}),
              ...(author ? { author } : {}),
            });
          } catch {
            threadsUnreadable += 1;
          }
        }
      } catch {
        channelsUnreadable += 1;
      }
    }

    // A fixed order, so two runs over the same workspace print the same report.
    const skips: FetchSkip[] = [];
    if (shortMessages > 0) {
      skips.push({ kind: 'shape', count: shortMessages, detail: 'messages with fewer than 2 replies (local mode reads threads only)' });
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
      skips.push({ kind: 'page_cap', count: historyCut, detail: `channels whose history was cut at ${maxHistoryPages} page(s) (raise maxHistoryPages)` });
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
    if (channelsUnreadable > 0) {
      skips.push({ kind: 'error', count: channelsUnreadable, detail: 'channels the token could not read' });
    }
    if (threadsUnreadable > 0) {
      skips.push({ kind: 'error', count: threadsUnreadable, detail: 'threads whose replies could not be read' });
    }

    return { items, report: { platform: 'slack', scanned: threadsScanned, requested: limit, skips } };
  }
}
