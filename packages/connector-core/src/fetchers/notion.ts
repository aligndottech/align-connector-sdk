import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchOneOptions, FetchResult, FetchSkip, FetchOneResult } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';
import { providerError } from './errors.js';
import { buildFetchReport, refusedRead } from './util/report.js';
import { budgetSpent, capOption, DescendingWindow } from './util/since.js';
import { parseWindow } from './util/time.js';
import { fetchOneInit, guardFetchOne, jsonOrThrow, shapeSkip, urlForDetail, vendorUrl } from './util/single.js';

/** Hosts a pasted Notion page URL may name. Requests go to api.notion.com regardless. */
const NOTION_HOSTS = ['notion.so', 'www.notion.so', 'api.notion.com'] as const;
import { normaliseSourceKey } from '../sourceKey.js';

interface NotionPage {
  id: string;
  url?: string;
  created_time?: string;
  last_edited_time?: string;
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
/** Notion's maximum page of block children, and how many such pages a page's body reads. */
const NOTION_BLOCK_PAGE_MAX = 100;
const NOTION_MAX_BLOCK_PAGES = 10;

/** Resolve a Notion user id to a name (cached). Degrades to undefined on failure. With a
 *  `signal` (fetchOne) the lookup is bounded by it, and an abort is rethrown so the
 *  single-item read reports its timeout instead of returning an item it did not finish. */
function makeNotionUserResolver(headers: Record<string, string>, signal?: AbortSignal) {
  const cache = new Map<string, { name: string; email?: string } | null>();
  return async (userId?: string): Promise<{ name: string; email?: string } | undefined> => {
    if (!userId) return undefined;
    if (cache.has(userId)) return cache.get(userId) ?? undefined;
    try {
      const url = `https://api.notion.com/v1/users/${userId}`;
      const res = signal ? await fetch(url, fetchOneInit(headers, signal)) : await fetch(url, { headers });
      if (!res.ok) {
        cache.set(userId, null);
        return undefined;
      }
      const u = (signal ? await jsonOrThrow(res) : await res.json()) as { name?: string; person?: { email?: string } };
      const resolved = u.name ? { name: u.name, ...(u.person?.email ? { email: u.person.email } : {}) } : null;
      cache.set(userId, resolved);
      return resolved ?? undefined;
    } catch (e) {
      if (signal?.aborted) throw e;
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

const NOTION_VERSION = '2022-06-28';

function notionHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, 'Notion-Version': NOTION_VERSION, 'Content-Type': 'application/json' };
}

/**
 * One page as an item: title, the first 50 blocks of body, the creator. The ONE mapper
 * for the list read and `fetchOne`, so a captured page and an imported page carry
 * identical fields. `bodyUnreadable` is set when the blocks call failed (the page is
 * still kept, title only).
 */
async function notionItem(
  page: NotionPage,
  headers: Record<string, string>,
  resolveUser: (id?: string) => Promise<{ name: string; email?: string } | undefined>,
  maxBlockPages: number,
  signal?: AbortSignal,
): Promise<{ item: FetcherItem; bodyUnreadable: boolean; blocksCut: boolean }> {
  const title = extractPageTitle(page);
  const pageUrl = page.url ?? `https://notion.so/${page.id.replace(/-/g, '')}`;
  const author = await resolveUser(page.created_by?.id);
  const createdAt = toIsoOrUndefined(page.created_time);
  const updatedAt = toIsoOrUndefined(page.last_edited_time);
  const sourceKey = normaliseSourceKey('notion', pageUrl);

  // Blocks are paged (page_size 100, start_cursor) up to maxBlockPages. A body that could
  // not be read, or that the cap cut, makes the item partial: the caller reports it.
  const texts: string[] = [];
  let bodyUnreadable = false;
  let blocksCut = false;
  let cursor: string | undefined;
  try {
    for (let pageNo = 0; ; pageNo++) {
      if (pageNo >= maxBlockPages) {
        blocksCut = true;
        break;
      }
      const blocksUrl =
        `https://api.notion.com/v1/blocks/${page.id}/children?page_size=${NOTION_BLOCK_PAGE_MAX}` +
        (cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : '');
      const blocksRes = signal ? await fetch(blocksUrl, fetchOneInit(headers, signal)) : await fetch(blocksUrl, { headers });
      if (!blocksRes.ok) {
        bodyUnreadable = true;
        break;
      }
      const blocks = (signal ? await jsonOrThrow(blocksRes) : await blocksRes.json()) as {
        results: NotionBlock[];
        has_more?: boolean;
        next_cursor?: string | null;
      };
      texts.push(...blocks.results.map(extractBlockText).filter(Boolean));
      cursor = blocks.has_more ? (blocks.next_cursor ?? undefined) : undefined;
      if (!cursor) break;
    }
  } catch (e) {
    // A timeout belongs to the single-item read's budget, not to "body unreadable".
    if (signal?.aborted) throw e;
    bodyUnreadable = true;
  }
  const bodyText = texts.join('\n');
  const partial = bodyUnreadable || blocksCut;

  return {
    item: {
      source_url: pageUrl,
      platform: 'notion',
      raw_text: [title, bodyText].filter(Boolean).join('\n\n').slice(0, 3000),
      title,
      ...(createdAt ? { created_at: createdAt } : {}),
      ...(updatedAt ? { updated_at: updatedAt } : {}),
      ...(sourceKey ? { source_key: sourceKey } : {}),
      ...(author ? { author } : {}),
      ...(partial ? { partial: true } : {}),
    },
    bodyUnreadable,
    blocksCut,
  };
}

/** The 32-hex page id a Notion URL names, via the same reader as the source key. */
function notionPageId(url: string): string | undefined {
  const key = normaliseSourceKey('notion', url);
  const id = key?.startsWith('https://www.notion.so/') ? key.slice('https://www.notion.so/'.length) : undefined;
  return id && /^[0-9a-f]{32}$/.test(id) ? id : undefined;
}

/**
 * Read-only personal Notion fetcher: pages the integration can see, with body
 * text from their child blocks. Author = the page creator ("who to talk to").
 * Pages the search with `start_cursor` while `has_more`, up to `limit`. A page
 * whose blocks cannot be read is kept (title only) and counted into the report.
 */
export class NotionFetcher implements ConnectorFetcher {
  /**
   * Capture one page by URL: `GET /v1/pages/{id}` plus its first 50 blocks (and the
   * creator lookup), from the 32-hex page id the URL ends with. Never throws.
   */
  async fetchOne(url: string, opts: FetchOneOptions): Promise<FetchOneResult> {
    // The host is checked first (https, no userinfo or port, an exact Notion host), then
    // the page id is read from the checked URL. The request goes to api.notion.com.
    const checked = vendorUrl(url, NOTION_HOSTS);
    const id = checked ? notionPageId(checked.href) : undefined;
    if (!id) return shapeSkip(`Notion URL not readable as one page (expected a notion.so page URL ending in its id): ${urlForDetail(url)}`);
    return guardFetchOne('Notion', opts.timeoutMs, async (signal) => {
      const headers = notionHeaders(opts.token);
      const page = await jsonOrThrow<NotionPage>(await fetch(`https://api.notion.com/v1/pages/${id}`, fetchOneInit(headers, signal)));
      const maxBlockPages = capOption(opts.maxBlockPages, NOTION_MAX_BLOCK_PAGES);
      const { item, bodyUnreadable, blocksCut } = await notionItem(page, headers, makeNotionUserResolver(headers, signal), maxBlockPages, signal);
      const skips: FetchSkip[] = [];
      if (bodyUnreadable) skips.push({ kind: 'error', count: 1, detail: 'page body could not be read (title only)' });
      if (blocksCut) skips.push({ kind: 'page_cap', count: 1, detail: `page blocks cut at ${maxBlockPages} page(s) of ${NOTION_BLOCK_PAGE_MAX} (raise maxBlockPages)` });
      return skips.length ? { item, skips } : { item };
    });
  }

  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
    const headers = notionHeaders(opts.token);
    const limit = opts.limit ?? 50;
    const win = parseWindow(opts.since as string | undefined, opts.until as string | undefined);
    if (!win.ok) return refusedRead({ platform: 'notion', requested: limit, scope: 'team', detail: win.detail });
    const window = new DescendingWindow(win.sinceMs, win.untilMs);
    const startedAt = Date.now();
    const resolveUser = makeNotionUserResolver(headers);
    const items: FetcherItem[] = [];
    let scanned = 0;
    let bodiesUnreadable = 0;
    let bodiesCut = 0;
    const maxBlockPages = capOption(opts.maxBlockPages, NOTION_MAX_BLOCK_PAGES);
    let cursor: string | undefined;
    let cutByLimit = false;
    let reachedSince = false;
    let outOfTime = false;

    do {
      if (items.length > 0 && budgetSpent(startedAt, opts.timeBudgetMs)) {
        outOfTime = true;
        break;
      }
      const searchRes = await fetch('https://api.notion.com/v1/search', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          filter: { value: 'page', property: 'object' },
          // Search has no date filter, so a window is newest first plus a client-side
          // stop at `since` (https://developers.notion.com/reference/post-search).
          sort: { timestamp: 'last_edited_time', direction: 'descending' },
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
        if (items.length >= limit) {
          cutByLimit = true;
          break;
        }
        scanned += 1;
        const place = window.place(page.last_edited_time);
        if (place === 'stop') {
          reachedSince = true;
          break;
        }
        if (place === 'drop') continue;
        const { item, bodyUnreadable, blocksCut } = await notionItem(page, headers, resolveUser, maxBlockPages);
        if (bodyUnreadable) bodiesUnreadable += 1;
        if (blocksCut) bodiesCut += 1;
        items.push(item);
      }
      cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
    } while (cursor && items.length < limit && !reachedSince);

    const skips: FetchSkip[] = [...window.skips('pages')];
    if (bodiesUnreadable > 0) {
      skips.push({ kind: 'error', count: bodiesUnreadable, detail: 'pages whose body could not be read (kept, title only)' });
    }
    if (bodiesCut > 0) {
      skips.push({ kind: 'page_cap', count: bodiesCut, detail: `pages whose blocks were cut at ${maxBlockPages} page(s) (kept, partial; raise maxBlockPages)` });
    }
    if (outOfTime) {
      skips.push({ kind: 'time_budget', count: 1, detail: `page search stopped before its end (the ${opts.timeBudgetMs} ms time budget ran out)` });
    }
    // Read to the end, or to the first page older than `since`, with nothing the limit cut.
    const exhausted = (reachedSince || cursor === undefined) && !cutByLimit && !outOfTime;
    return { items, report: buildFetchReport(items, { platform: 'notion', scanned, requested: limit, skips, scope: 'team', untilMs: win.untilMs, exhausted }) };
  }
}
