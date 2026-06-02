import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem } from '../types/fetcher.js';
import { FetcherAuthError } from './errors.js';

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

interface ConfluencePageV2 {
  title: string;
  authorId?: string;
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
}

/** Resolve a Confluence accountId to a display name (cached). Degrades to undefined
 *  if the token lacks read:confluence-user or the lookup fails. */
function makeConfluenceUserResolver(base: string, headers: Record<string, string>) {
  const cache = new Map<string, { name: string; email?: string } | null>();
  return async (accountId?: string): Promise<{ name: string; email?: string } | undefined> => {
    if (!accountId) return undefined;
    if (cache.has(accountId)) return cache.get(accountId) ?? undefined;
    try {
      const res = await fetch(`${base}/rest/api/user?accountId=${encodeURIComponent(accountId)}`, { headers });
      if (!res.ok) {
        cache.set(accountId, null);
        return undefined;
      }
      const u = (await res.json()) as { displayName?: string; publicName?: string; email?: string };
      const name = u.displayName || u.publicName;
      const resolved = name ? { name, ...(u.email ? { email: u.email } : {}) } : null;
      cache.set(accountId, resolved);
      return resolved ?? undefined;
    } catch {
      cache.set(accountId, null);
      return undefined;
    }
  };
}

/**
 * Read-only personal Confluence fetcher (API v2): pages the token can read.
 * OAuth (cloudId) or basic-auth (domain+email). Author = the page author.
 */
export class ConfluenceFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    const cloudId = opts.cloudId as string | undefined;
    const siteBase = opts.siteBase as string | undefined;
    const email = opts.email as string | undefined;
    const domain = opts.domain as string | undefined;

    const isOAuth = Boolean(cloudId);
    const base = isOAuth
      ? `https://api.atlassian.com/ex/confluence/${cloudId}/wiki`
      : `https://${domain}/wiki`;
    const headers: Record<string, string> = isOAuth
      ? { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' }
      : {
          Authorization: `Basic ${Buffer.from(`${email}:${opts.token}`).toString('base64')}`,
          Accept: 'application/json',
        };

    const limit = opts.limit ?? 50;
    const url = `${base}/api/v2/pages?limit=${limit}&body-format=storage`;

    const res = await fetch(url, { headers });
    if (!res.ok) {
      if (res.status === 401) throw new FetcherAuthError('Confluence');
      if (res.status === 403) {
        throw new Error(
          'Confluence access denied (403): the token lacks Confluence scopes or this site has no Confluence. ' +
            "Re-auth won't help - check the Atlassian app's Confluence API permissions (or skip Confluence).",
        );
      }
      throw new Error(
        `Confluence API failed (${res.status}). ${isOAuth ? 'Check your OAuth token.' : 'Check your email, token, and domain.'}`,
      );
    }
    const data = (await res.json()) as { results: ConfluencePageV2[]; _links?: { base?: string } };

    const humanBase = isOAuth
      ? (siteBase ?? `https://api.atlassian.com/ex/confluence/${cloudId}`)
      : `https://${domain}`;
    const linkBase = data._links?.base ?? `${humanBase}/wiki`;
    const resolveUser = makeConfluenceUserResolver(base, headers);

    const items: FetcherItem[] = [];
    for (const page of data.results ?? []) {
      const bodyHtml = page.body?.storage?.value ?? '';
      const bodyText = stripHtml(bodyHtml).slice(0, 2000);
      const webui = page._links?.webui ?? '';
      const pageUrl = webui.startsWith('http') ? webui : `${linkBase}${webui}`;
      const author = await resolveUser(page.authorId);
      items.push({
        source_url: pageUrl,
        platform: 'confluence',
        raw_text: [page.title, bodyText].filter(Boolean).join('\n\n'),
        title: page.title,
        ...(author ? { author } : {}),
      });
    }
    return items;
  }
}
