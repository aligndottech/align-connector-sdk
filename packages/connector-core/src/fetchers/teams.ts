import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchResult } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';
import { providerError, refusedBody } from './errors.js';
import { buildFetchReport } from './util/report.js';

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
interface TeamsMessage {
  id: string;
  createdDateTime?: string;
  subject?: string;
  webUrl?: string;
  body?: TeamsMessageBody;
  from?: { user?: { displayName?: string; id?: string } };
  replies?: Array<{ body?: TeamsMessageBody }>;
}

async function graphGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
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

/**
 * Read-only personal Teams fetcher: recent channel messages (+replies) across the
 * caller's joined teams. Author = the message author. Needs admin-consented
 * ChannelMessage.Read.All.
 */
export class TeamsFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
    const limit = opts.limit ?? 50;
    const teams = await graphGet<{ value: TeamsTeam[] }>('/me/joinedTeams', opts.token);
    const items: FetcherItem[] = [];
    let scanned = 0;
    // Not complete when anything was left unread: the limit stopped the loop, a channel
    // had more than the one page read ($top=10, no paging yet), or a channel refused.
    // None of these is a skip line yet (S3 adds them); `complete` must not wait for that.
    let unread = false;

    for (const team of teams.value) {
      if (items.length >= limit) {
        unread = true;
        break;
      }
      const channels = await graphGet<{ value: TeamsChannel[] }>(`/teams/${team.id}/channels`, opts.token);
      for (const channel of channels.value) {
        if (items.length >= limit) {
          unread = true;
          break;
        }
        try {
          const msgs = await graphGet<{ value: TeamsMessage[]; '@odata.nextLink'?: string }>(
            `/teams/${team.id}/channels/${channel.id}/messages?$top=10`,
            opts.token,
          );
          if (msgs['@odata.nextLink']) unread = true;
          for (const msg of msgs.value) {
            if (items.length >= limit) {
              unread = true;
              break;
            }
            scanned += 1;
            const mainText = extractText(msg.body);
            const replyTexts = (msg.replies ?? []).map((r) => extractText(r.body)).filter(Boolean);
            const raw_text = [
              `[${team.displayName} > #${channel.displayName}]`,
              msg.subject ? `Subject: ${msg.subject}` : '',
              mainText,
              ...replyTexts,
            ]
              .filter(Boolean)
              .join('\n');

            const fromName = msg.from?.user?.displayName;
            const createdAt = toIsoOrUndefined(msg.createdDateTime);
            items.push({
              source_url: msg.webUrl ?? 'https://teams.microsoft.com',
              platform: 'teams',
              raw_text,
              title: (msg.subject ?? mainText).slice(0, 80) || `Message in ${team.displayName}`,
              ...(createdAt ? { created_at: createdAt } : {}),
              ...(fromName ? { author: { name: fromName } } : {}),
            });
          }
        } catch {
          /* skip inaccessible channels */
          unread = true;
        }
      }
    }

    return {
      items,
      report: buildFetchReport(items, { platform: 'teams', scanned, requested: limit, skips: [], scope: 'team', exhausted: !unread }),
    };
  }
}
