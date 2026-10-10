import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchOneOptions, FetchResult, FetchSkip, FetchOneResult } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';
import { FetcherAuthError, providerError, refusedBody } from './errors.js';
import { buildFetchReport, refusedRead } from './util/report.js';
import { budgetSpent, DescendingWindow } from './util/since.js';
import { parseWindow } from './util/time.js';
import { fetchOneInit, guardFetchOne, jsonOrThrow, shapeSkip, urlForDetail, vendorUrl } from './util/single.js';
import { normaliseSourceKey } from '../sourceKey.js';

/** Graph's documented maximum page for list channel messages. */
const TEAMS_PAGE_MAX = 50;
/** Message pages read per channel before the cap fires (1,000 root messages at 50). */
const TEAMS_MAX_MESSAGE_PAGES = 20;
/** Reply pages read per thread by fetchOne (list replies, $top <= 50). */
const TEAMS_MAX_REPLY_PAGES = 20;

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

interface TeamsTeam {
  id: string;
  displayName: string;
}
interface TeamsChannel {
  id: string;
  displayName: string;
}
interface TeamsMessageBody {
  content?: string;
  contentType?: string;
}
interface TeamsReply {
  id?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  body?: TeamsMessageBody;
}
interface TeamsMessage {
  id: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  subject?: string;
  webUrl?: string;
  body?: TeamsMessageBody;
  from?: { user?: { displayName?: string; id?: string } };
  replies?: TeamsReply[];
  'replies@odata.nextLink'?: string;
}

/** A next link that is not on graph.microsoft.com: never followed, the Bearer goes nowhere else. */
class OffHostLinkError extends Error {
  constructor() {
    super('Teams returned a next link not on graph.microsoft.com; it was not followed');
    this.name = 'OffHostLinkError';
  }
}

async function graphGet<T>(path: string, token: string): Promise<T> {
  // A nextLink is absolute and comes from the response, so it is held to the vendor rules
  // (https, graph.microsoft.com exactly, no userinfo or port) before the Bearer is sent.
  // Anything with a scheme is absolute; only a bare path is relative to v1.0.
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(path);
  if (absolute && !vendorUrl(path, ['graph.microsoft.com'])) throw new OffHostLinkError();
  const url = absolute ? path : `https://graph.microsoft.com/v1.0${path}`;
  // No redirects: a 3xx arrives as a non-OK answer instead of carrying the Bearer elsewhere.
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual' });
  if (res.status === 401) throw await providerError('Teams', res);
  if (!res.ok) {
    // Read the body once: the consent branch needs Graph's error code, and providerError
    // needs the same bytes for the message.
    const raw = await refusedBody(res);
    let code = '';
    try {
      code = ((JSON.parse(raw) as { error?: { code?: string } }).error?.code) ?? '';
    } catch {
      /* not JSON; no code to read */
    }
    if (res.status === 403 || code.includes('Authorization') || code.includes('Consent')) {
      throw new Error(
        'Teams requires admin consent for ChannelMessage.Read.All. ' +
          'Ask your Microsoft 365 admin to grant consent, or see: ' +
          'https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ConsentPoliciesMenuBlade',
      );
    }
    throw await providerError('Teams', { status: res.status, text: async () => raw });
  }
  return res.json() as Promise<T>;
}

function extractText(body: TeamsMessageBody | undefined): string {
  if (!body?.content) return '';
  return body.contentType === 'html' ? stripHtml(body.content) : body.content;
}

/** The newest of the root's and its replies' modified/created times: the reply-chain
 *  last-modified Graph sorts the channel listing by. */
function chainTime(msg: TeamsMessage, replies: TeamsReply[]): string | undefined {
  let best: number | undefined;
  for (const t of [msg.lastModifiedDateTime, msg.createdDateTime, ...replies.flatMap((r) => [r.lastModifiedDateTime, r.createdDateTime])]) {
    const iso = toIsoOrUndefined(t);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (best === undefined || ms > best) best = ms;
  }
  return best === undefined ? undefined : new Date(best).toISOString();
}

/** One root message plus its replies as an item. The ONE mapper for the list read and fetchOne. */
function teamsItem(msg: TeamsMessage, replies: TeamsReply[], teamName: string, channelName: string): FetcherItem {
  const mainText = extractText(msg.body);
  const replyTexts = replies.map((r) => extractText(r.body)).filter(Boolean);
  const raw_text = [`[${teamName} > #${channelName}]`, msg.subject ? `Subject: ${msg.subject}` : '', mainText, ...replyTexts]
    .filter(Boolean)
    .join('\n');
  const fromName = msg.from?.user?.displayName;
  const createdAt = toIsoOrUndefined(msg.createdDateTime);
  const updatedAt = chainTime(msg, replies);
  // The fallback is a bare host, which names no item, so it gets no key (S1).
  const sourceUrl = msg.webUrl ?? 'https://teams.microsoft.com';
  const sourceKey = msg.webUrl ? normaliseSourceKey('teams', msg.webUrl) : undefined;
  return {
    source_url: sourceUrl,
    platform: 'teams',
    raw_text,
    title: (msg.subject ?? mainText).slice(0, 80) || `Message in ${teamName}`,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(sourceKey ? { source_key: sourceKey } : {}),
    ...(fromName ? { author: { name: fromName } } : {}),
  };
}

/** An Entra group (team) id. */
const TEAM_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A channel thread id. No `/`, `?`, `#`, backslash or whitespace can reach the path. */
const CHANNEL_ID = /^19:[^/?#\\\s]+@thread\.(tacv2|skype)$/;
const MESSAGE_ID = /^\d+$/;

/**
 * Team id, channel id and thread-root message id from a Teams message link, else
 * undefined. Every id is validated against its own shape BEFORE it can reach a Graph path,
 * and the caller still encodes each one: the ids come from text a person or agent pasted,
 * and an unchecked `groupId=x/../../me/messages/M1` once read a private mailbox message.
 */
function parseMessageLink(url: string): { teamId: string; channelId: string; messageId: string; teamName?: string; channelName?: string } | undefined {
  const u = vendorUrl(url, ['teams.microsoft.com']);
  if (!u) return undefined;
  const m = /^\/l\/message\/([^/]+)\/(\d+)\/?$/.exec(u.pathname);
  const teamId = u.searchParams.get('groupId');
  if (!m || !teamId || !TEAM_ID.test(teamId)) return undefined;
  let channelId: string;
  try {
    channelId = decodeURIComponent(m[1]!);
  } catch {
    return undefined;
  }
  if (!CHANNEL_ID.test(channelId) || channelId.includes('..')) return undefined;
  // A reply's link names its thread root in parentMessageId; the thread is the item.
  const parent = u.searchParams.get('parentMessageId');
  const messageId = parent && MESSAGE_ID.test(parent) ? parent : m[2]!;
  const teamName = u.searchParams.get('teamName');
  const channelName = u.searchParams.get('channelName');
  return { teamId, channelId, messageId, ...(teamName ? { teamName } : {}), ...(channelName ? { channelName } : {}) };
}

/**
 * Read-only personal Teams fetcher: recent channel messages (+replies) across the
 * caller's joined teams. Author = the message author. Needs admin-consented
 * ChannelMessage.Read.All.
 */
export class TeamsFetcher implements ConnectorFetcher {
  /**
   * Capture one thread by message link: get the root message, then list its replies
   * (get-message takes no OData parameters, so `$expand=replies` is not available there;
   * https://learn.microsoft.com/en-us/graph/api/chatmessage-get). Team and channel names
   * come from the link when it carries them, else one call each. Never throws.
   */
  async fetchOne(url: string, opts: FetchOneOptions): Promise<FetchOneResult> {
    const link = parseMessageLink(url);
    if (!link) return shapeSkip(`Teams URL not read: not a channel message link with a valid team and channel id: ${urlForDetail(url)}`);
    const maxReplyPages = (opts.maxReplyPages as number | undefined) ?? TEAMS_MAX_REPLY_PAGES;
    return guardFetchOne('Teams', opts.timeoutMs, async (signal) => {
      const headers = { Authorization: `Bearer ${opts.token}` };
      const get = async <T>(pathOrNext: string): Promise<T> => {
        // A nextLink is only followed on Graph's own host; anything else ends the read.
        const url = pathOrNext.startsWith('https://') ? pathOrNext : `https://graph.microsoft.com/v1.0${pathOrNext}`;
        if (!vendorUrl(url, ['graph.microsoft.com'])) throw new Error('Teams returned a next link off graph.microsoft.com');
        return jsonOrThrow<T>(await fetch(url, fetchOneInit(headers, signal)));
      };
      const team = encodeURIComponent(link.teamId);
      const channel = encodeURIComponent(link.channelId);
      const base = `/teams/${team}/channels/${channel}/messages/${link.messageId}`;
      const msg = await get<TeamsMessage>(base);
      const replies: TeamsReply[] = [];
      let next: string | undefined = `${base}/replies?$top=${TEAMS_PAGE_MAX}`;
      for (let page = 0; next && page < maxReplyPages; page++) {
        const data: { value?: TeamsReply[]; '@odata.nextLink'?: string } = await get(next);
        replies.push(...(data.value ?? []));
        next = data['@odata.nextLink'];
      }
      const teamName = link.teamName ?? (await get<{ displayName: string }>(`/teams/${team}`)).displayName;
      const channelName = link.channelName ?? (await get<{ displayName: string }>(`/teams/${team}/channels/${channel}`)).displayName;
      const item = teamsItem(msg, replies, teamName, channelName);
      if (!next) return { item };
      return {
        item: { ...item, partial: true },
        skips: [{ kind: 'page_cap', count: 1, detail: `thread replies cut at ${maxReplyPages} page(s) of ${TEAMS_PAGE_MAX} (raise maxReplyPages)` }],
      };
    });
  }

  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
    const limit = opts.limit ?? 50;
    const win = parseWindow(opts.since as string | undefined, opts.until as string | undefined);
    if (!win.ok) return refusedRead({ platform: 'teams', requested: limit, scope: 'team', detail: win.detail });

    const maxPages = (opts.maxMessagePages as number | undefined) ?? TEAMS_MAX_MESSAGE_PAGES;
    const startedAt = Date.now();
    const teams = await graphGet<{ value: TeamsTeam[] }>('/me/joinedTeams', opts.token);
    const items: FetcherItem[] = [];
    const orderSkips: FetchSkip[] = [];
    let scanned = 0;
    let cutByLimit = false;
    let channelsUnreadable = 0;
    let linksRefused = 0;
    let channelsRefused = 0;
    let channelsPageCut = 0;
    let threadsRepliesCut = 0;
    let channelsOutOfTime = 0;
    let channelsSeen = 0;

    // Channels first, so the time budget can name how many it did not reach.
    const targets: Array<{ team: TeamsTeam; channel: TeamsChannel }> = [];
    for (const team of teams.value) {
      const channels = await graphGet<{ value: TeamsChannel[] }>(`/teams/${team.id}/channels`, opts.token);
      for (const channel of channels.value) targets.push({ team, channel });
    }

    for (let ci = 0; ci < targets.length; ci++) {
      const { team, channel } = targets[ci]!;
      if (items.length >= limit) {
        cutByLimit = true;
        break;
      }
      if (channelsSeen > 0 && budgetSpent(startedAt, opts.timeBudgetMs)) {
        channelsOutOfTime = targets.length - ci;
        break;
      }
      channelsSeen += 1;
      // $expand=replies is REQUIRED: the list returns roots without replies otherwise
      // (P0, docs-confirmed). The listing is sorted by reply-chain last modified, newest
      // first, and has no $filter, so the window is a client-side stop.
      let next: string | undefined = `/teams/${team.id}/channels/${channel.id}/messages?$top=${TEAMS_PAGE_MAX}&$expand=replies`;
      const order = new DescendingWindow(win.sinceMs, win.untilMs);
      let pages = 0;
      let reachedSince = false;
      try {
        while (next) {
          if (pages >= maxPages) {
            channelsPageCut += 1;
            break;
          }
          const msgs: { value: TeamsMessage[]; '@odata.nextLink'?: string } = await graphGet(next, opts.token);
          pages += 1;
          for (const msg of msgs.value) {
            if (items.length >= limit) {
              cutByLimit = true;
              break;
            }
            scanned += 1;
            const replies = msg.replies ?? [];
            const place = order.place(chainTime(msg, replies));
            if (place === 'stop') {
              reachedSince = true;
              break;
            }
            if (place === 'drop') continue;
            const item = teamsItem(msg, replies, team.displayName, channel.displayName);
            if (msg['replies@odata.nextLink']) {
              threadsRepliesCut += 1;
              items.push({ ...item, partial: true }); // later replies not read: merge, never replace
            } else {
              items.push(item);
            }
          }
          if (reachedSince || cutByLimit) break;
          next = msgs['@odata.nextLink'];
        }
      } catch (e) {
        // A channel that refused is reported, never swallowed: the token was refused
        // (auth, likely the ~1 hour token expiring mid-read) or the channel is closed to it.
        if (e instanceof OffHostLinkError) linksRefused += 1;
        else if (e instanceof FetcherAuthError) channelsRefused += 1;
        else channelsUnreadable += 1;
      }
      orderSkips.push(...order.skips(`messages in ${team.displayName} > #${channel.displayName}`));
    }

    const skips: FetchSkip[] = [...orderSkips];
    if (channelsPageCut > 0) {
      skips.push({ kind: 'page_cap', count: channelsPageCut, detail: `channels whose messages were cut at ${maxPages} page(s) of ${TEAMS_PAGE_MAX} (raise maxMessagePages)` });
    }
    if (threadsRepliesCut > 0) {
      skips.push({ kind: 'page_cap', count: threadsRepliesCut, detail: 'threads with more replies than one expanded page (kept, later replies not read)' });
    }
    if (channelsOutOfTime > 0) {
      skips.push({ kind: 'time_budget', count: channelsOutOfTime, detail: `channels not read (the ${opts.timeBudgetMs} ms time budget ran out)` });
    }
    if (linksRefused > 0) {
      skips.push({ kind: 'shape', count: linksRefused, detail: 'channels whose next links not on graph.microsoft.com were refused (not followed; later messages unread)' });
    }
    if (channelsUnreadable > 0) {
      skips.push({ kind: 'error', count: channelsUnreadable, detail: 'channels the token could not read' });
    }
    if (channelsRefused > 0) {
      skips.push({ kind: 'auth', count: channelsRefused, detail: 'channels where Teams refused the token (it may have expired: reconnect Teams)' });
    }

    return {
      items,
      report: buildFetchReport(items, { platform: 'teams', scanned, requested: limit, skips, scope: 'team', exhausted: !cutByLimit && linksRefused === 0 }),
    };
  }
}
