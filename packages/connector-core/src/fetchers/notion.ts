import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchResult, FetchSkip } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';
import { providerError } from './errors.js';

interface NotionPage {
  id: string;
  url?: string;
  created_time?: string;
  created_by?: { id?: string };
  properties?: {
    title?: { title?: Array<{ plain_text?: string }> };
    Name?: { title?: Array<{ plain_text?: string }> };
    [key: string]: unknown;
  };
}

interface NotionBlock {
  type: string;
  [key: string]: unknown;
}

// Notion's own per-page maximum for /v1/search. Before ALI-828 the read was one
// page sized to the limit, with the cursor Notion returned never sent back.
const NOTION_PAGE_MAX = 100;

/** Resolve a Notion user id to a name (cached). Degrades to undefined on failure. */
function makeNotionUserResolver(headers: Record<string, string>) {
  const cache = new Map<string, { name: string; email?: string } | null>();
  return async (userId?: string): Promise<{ name: string; email?: string } | undefined> => {
    if (!userId) return undefined;
    if (cache.has(userId)) return cache.get(userId) ?? undefined;
    try {
      const res = await fetch(`https://api.notion.com/v1/users/${userId}`, { headers });
      if (!res.ok) {
        cache.set(userId, null);
        return undefined;
      }
      const u = (await res.json()) as { name?: string; person?: { email?: string } };
      const resolved = u.name ? { name: u.name, ...(u.person?.email ? { email: u.person.email } : {}) } : null;
      cache.set(userId, resolved);
      return resolved ?? undefined;
    } catch {
      cache.set(userId, null);
      return undefined;
    }
  };
}

function extractPageTitle(page: NotionPage): string {
  return (
    page.properties?.title?.title?.[0]?.plain_text ??
    page.properties?.Name?.title?.[0]?.plain_text ??
    'Untitled'
  );
}

function extractBlockText(block: NotionBlock): string {
  const content = block[block.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  return (content?.rich_text ?? []).map((t) => t.plain_text ?? '').join('');
}

/**
 * Read-only personal Notion fetcher: pages the integration can see, with body
 * text from their child blocks. Author = the page creator ("who to talk to").
 * Pages the search with `start_cursor` while `has_more`, up to `limit`. A page
 * whose blocks cannot be read is kept (title only) and counted into the report.
 */
export class NotionFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
    const headers = {
      Authorization: `Bearer ${opts.token}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json',
    };
    const limit = opts.limit ?? 50;
    const resolveUser = makeNotionUserResolver(headers);
    const items: FetcherItem[] = [];
    let scanned = 0;
    let bodiesUnreadable = 0;
    let cursor: string | undefined;

    do {
      const searchRes = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          filter: { value: 'page', property: 'object' },
          page_size: Math.min(limit - items.length, NOTION_PAGE_MAX),
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      });
      if (!searchRes.ok) {
        throw await providerError('Notion', searchRes, {
          forbidden: 'Share the pages with the integration: Notion lets an integration read only what it has been given.',
        });
      }
      const data = (await searchRes.json()) as { results: NotionPage[]; has_more?: boolean; next_cursor?: string | null };

      for (const page of data.results) {
        if (items.length >= limit) break;
        scanned += 1;
        const title = extractPageTitle(page);
        const pageUrl = page.url ?? `https://notion.so/${page.id.replace(/-/g, '')}`;
        const author = await resolveUser(page.created_by?.id);
        const createdAt = toIsoOrUndefined(page.created_time);

        let bodyText = '';
        try {
          const blocksRes = await fetch(`https://api.notion.com/v1/blocks/${page.id}/children?page_size=50`, { headers });
          if (blocksRes.ok) {
            const blocks = (await blocksRes.json()) as { results: NotionBlock[] };
            bodyText = blocks.results.map(extractBlockText).filter(Boolean).join('\n');
          } else {
            bodiesUnreadable += 1;
          }
        } catch {
          bodiesUnreadable += 1;
        }

        items.push({
          source_url: pageUrl,
          platform: 'notion',
          raw_text: [title, bodyText].filter(Boolean).join('\n\n').slice(0, 3000),
          title,
          ...(createdAt ? { created_at: createdAt } : {}),
          ...(author ? { author } : {}),
        });
      }
      cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
    } while (cursor && items.length < limit);

    const skips: FetchSkip[] = [];
    if (bodiesUnreadable > 0) {
      skips.push({ kind: 'error', count: bodiesUnreadable, detail: 'pages whose body could not be read (kept, title only)' });
    }
    return { items, report: { platform: 'notion', scanned, requested: limit, skips } };
  }
}
