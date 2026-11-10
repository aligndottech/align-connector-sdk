import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchOneOptions, FetchResult, FetchSkip, FetchOneResult } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';
import { providerError } from './errors.js';
import { buildFetchReport, refusedRead } from './util/report.js';
import { budgetSpent, capOption, DescendingWindow, optionSkips, withOptionSkips } from './util/since.js';
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

/** Notion read options beyond the shared ones. */
export interface NotionFetcherOptions extends ConnectorFetcherOptions {
  /**
   * Page or database ids (32 hex or dashed uuid). Narrows the read to these pages and their
   * descendants (child pages, and the pages of child databases) instead of a workspace search.
   * An id the token cannot read is a skip in the report; an id that is not an id refuses the read.
   * Child pages nested inside toggles, columns, callouts or other container blocks are NOT found
   * (only a page's top-level child_page and child_database blocks are); a `shape` skip says when
   * such blocks were seen.
   */
  pages?: string[];
}

interface NotionBlock {
  type: string;
  id?: string;
  has_children?: boolean;
  [key: string]: unknown;
}

// Notion's own per-page maximum for /v1/search. Before ALI-828 the read was one
// page sized to the limit, with the cursor Notion returned never sent back.
const NOTION_PAGE_MAX = 100;
/** Notion's maximum page of block children, and how many such pages a page's body reads. */
const NOTION_BLOCK_PAGE_MAX = 100;
const NOTION_MAX_BLOCK_PAGES = 10;
const NOTION_BLOCK_PAGE_CEILING = 100;

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
      const res = signal ? await fetch(url, fetchOneInit(headers, signal)) : await fetch(url, { headers, redirect: 'manual' });
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
): Promise<{ item: FetcherItem; bodyUnreadable: boolean; blocksCut: boolean; children: NotionChild[]; nested: boolean }> {
  const title = extractPageTitle(page);
  const pageUrl = page.url ?? `https://notion.so/${page.id.replace(/-/g, '')}`;
  const author = await resolveUser(page.created_by?.id);
  const createdAt = toIsoOrUndefined(page.created_time);
  const updatedAt = toIsoOrUndefined(page.last_edited_time);
  const sourceKey = normaliseSourceKey('notion', pageUrl);

  // Blocks are paged (page_size 100, start_cursor) up to maxBlockPages. A body that could
  // not be read, or that the cap cut, makes the item partial: the caller reports it.
  const texts: string[] = [];
  const children: NotionChild[] = [];
  let nested = false;
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
      const blocksRes = signal ? await fetch(blocksUrl, fetchOneInit(headers, signal)) : await fetch(blocksUrl, { headers, redirect: 'manual' });
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
      for (const b of blocks.results) {
        const id = typeof b.id === 'string' ? notionId(b.id) : undefined;
        if (id && (b.type === 'child_page' || b.type === 'child_database')) children.push({ id, kind: b.type === 'child_page' ? 'page' : 'database' });
        else if (b.has_children === true) nested = true;
      }
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
    children,
    nested,
  };
}

/** A child page or child database found in a page's blocks, by 32-hex id. */
interface NotionChild {
  id: string;
  kind: 'page' | 'database';
}

/** Notion's two id spellings, 32 hex or dashed uuid, read as the 32-hex form; undefined for anything else. */
function notionId(raw: string): string | undefined {
  const bare = raw.replace(/-/g, '').toLowerCase();
  const ok = /^[0-9a-f]{32}$/.test(bare) && (raw.length === 32 || /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(raw));
  return ok ? bare : undefined;
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
 * With `pages`, reads only those pages and their descendants instead (see {@link NotionFetcherOptions}).
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
      const blockCap = capOption('maxBlockPages', opts.maxBlockPages, NOTION_MAX_BLOCK_PAGES, NOTION_BLOCK_PAGE_CEILING);
      const maxBlockPages = blockCap.value;
      const { item, bodyUnreadable, blocksCut } = await notionItem(page, headers, makeNotionUserResolver(headers, signal), maxBlockPages, signal);
      const skips: FetchSkip[] = [];
      if (bodyUnreadable) skips.push({ kind: 'error', count: 1, detail: 'page body could not be read (title only)' });
      if (blocksCut) skips.push({ kind: 'page_cap', count: 1, detail: `page blocks cut at ${maxBlockPages} page(s) of ${NOTION_BLOCK_PAGE_MAX} (raise maxBlockPages)` });
      return withOptionSkips(skips.length ? { item, skips } : { item }, [blockCap]);
    });
  }

  async fetch(opts: NotionFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }


  /**
   * The `pages` read: the named pages and everything under them, breadth first. A tree has no
   * edit-time order, so `since`/`until` only filter (a dropped page's children are still read)
   * and nothing stops early. A root is tried as a page, then as a database; a database lists
   * its pages through the query endpoint, a page lists its child_page and child_database blocks.
   */
  private async fetchSubtrees(
    opts: NotionFetcherOptions,
    given: string[],
    headers: Record<string, string>,
    limit: number,
    win: { sinceMs?: number; untilMs?: number },
  ): Promise<FetchResult> {
    const roots: string[] = [];
    const invalid: string[] = [];
    for (const raw of given) {
      const id = typeof raw === 'string' ? notionId(raw) : undefined;
      if (!id) invalid.push(String(raw).slice(0, 80));
      else if (!roots.includes(id)) roots.push(id);
    }
    if (invalid.length > 0) {
      return refusedRead({
        platform: 'notion',
        requested: limit,
        scope: 'team',
        detail: `pages must be Notion page or database ids (32 hex or a dashed uuid); not read: ${invalid.join(', ')}`,
      });
    }
    const startedAt = Date.now();
    const resolveUser = makeNotionUserResolver(headers);
    const blockCap = capOption('maxBlockPages', opts.maxBlockPages, NOTION_MAX_BLOCK_PAGES, NOTION_BLOCK_PAGE_CEILING);
    const maxBlockPages = blockCap.value;
    const items: FetcherItem[] = [];
    const unreadable: string[] = [];
    const queue: Array<{ id: string; kind: 'page' | 'database' | 'either' }> = roots.map((id) => ({ id, kind: 'either' }));
    const seen = new Set<string>(roots);
    let scanned = 0;
    let undated = 0;
    let bodiesUnreadable = 0;
    let bodiesCut = 0;
    let nestedPages = 0;
    let cutByLimit = false;
    let outOfTime = false;
    const dbBroken: string[] = [];

    const get = async (url: string, init?: { method: string; body: string }) => {
      const res = await fetch(url, { headers, redirect: 'manual', ...init });
      // Only "not there / not allowed / wrong kind" is an answer about this id. Anything else
      // (401, 429, 5xx) says nothing about the id, so it is the whole read's problem.
      if (!res.ok && ![400, 403, 404].includes(res.status)) throw await providerError('Notion', res, {});
      return res;
    };
    const enqueue = (children: NotionChild[]) => {
      for (const c of children) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        queue.push(c);
      }
    };
    // One page: keep it if it is in the window, and queue what is under it either way.
    const visit = async (pg: NotionPage) => {
      scanned += 1;
      const { item, bodyUnreadable, blocksCut, children, nested } = await notionItem(pg, headers, resolveUser, maxBlockPages);
      enqueue(children);
      // Counted before the window check: a dropped page's failed or cut read still left children unfound.
      if (bodyUnreadable) bodiesUnreadable += 1;
      if (blocksCut) bodiesCut += 1;
      if (nested) nestedPages += 1;
      const ms = Date.parse(toIsoOrUndefined(pg.last_edited_time) ?? '');
      if (Number.isNaN(ms)) undated += 1;
      else if ((win.sinceMs !== undefined && ms < win.sinceMs) || (win.untilMs !== undefined && ms >= win.untilMs)) return;
      items.push(item);
    };
    const readDatabase = async (id: string): Promise<boolean> => {
      let cursor: string | undefined;
      let first = true;
      do {
        if (items.length >= limit) {
          cutByLimit = true;
          return true;
        }
        const res = await get(`https://api.notion.com/v1/databases/${id}/query`, {
          method: 'POST',
          body: JSON.stringify({ page_size: NOTION_PAGE_MAX, ...(cursor ? { start_cursor: cursor } : {}) }),
        });
        if (!res.ok) {
          if (first) return false;
          dbBroken.push(id); // pages after the first were not read
          return true;
        }
        first = false;
        const data = (await res.json()) as { results: NotionPage[]; has_more?: boolean; next_cursor?: string | null };
        for (const pg of data.results) {
          const pid = notionId(pg.id);
          if (pid && !seen.has(pid)) seen.add(pid);
          else if (pid) continue;
          if (items.length >= limit) {
            cutByLimit = true;
            return true;
          }
          await visit(pg);
        }
        cursor = data.has_more ? (data.next_cursor ?? undefined) : undefined;
      } while (cursor);
      return true;
    };

    while (queue.length > 0) {
      if (items.length >= limit) {
        cutByLimit = true;
        break;
      }
      // scanned, not items: a window matching nothing keeps no items but must still be bounded.
      if (scanned > 0 && budgetSpent(startedAt, opts.timeBudgetMs)) {
        outOfTime = true;
        break;
      }
      const next = queue.shift()!;
      let read = false;
      if (next.kind !== 'database') {
        const res = await get(`https://api.notion.com/v1/pages/${next.id}`);
        if (res.ok) {
          await visit((await res.json()) as NotionPage);
          read = true;
        }
      }
      if (!read && next.kind !== 'page') read = await readDatabase(next.id);
      if (!read) unreadable.push(next.id);
    }

    const skips: FetchSkip[] = [];
    if (undated > 0) skips.push({ kind: 'shape', count: undated, detail: 'pages with no last-modified time (kept: they cannot be placed in the window)' });
    if (unreadable.length > 0) {
      skips.push({ kind: 'error', count: unreadable.length, detail: `pages or databases not found or not shared with this integration: ${unreadable.join(', ')}` });
    }
    if (dbBroken.length > 0) {
      skips.push({ kind: 'error', count: dbBroken.length, detail: `databases whose later pages were refused after the first page: ${dbBroken.join(', ')}` });
    }
    if (bodiesUnreadable > 0) skips.push({ kind: 'error', count: bodiesUnreadable, detail: 'pages whose body could not be read (title only if kept)' });
    if (bodiesCut > 0) {
      skips.push({ kind: 'page_cap', count: bodiesCut, detail: `pages whose blocks were cut at ${maxBlockPages} page(s) (partial; raise maxBlockPages)` });
    }
    if (nestedPages > 0) {
      skips.push({ kind: 'shape', count: nestedPages, detail: 'pages with nested blocks (toggles, columns, callouts) whose child pages are not read' });
    }
    if (outOfTime) {
      skips.push({ kind: 'time_budget', count: 1, detail: `page walk stopped before its end (the ${opts.timeBudgetMs} ms time budget ran out)` });
    }
    skips.push(...optionSkips([blockCap]));
    const exhausted = !cutByLimit && !outOfTime;
    return { items, report: buildFetchReport(items, { platform: 'notion', scanned, requested: limit, skips, scope: 'team', untilMs: win.untilMs, exhausted }) };
  }

  async fetchWithReport(opts: NotionFetcherOptions): Promise<FetchResult> {
    const headers = notionHeaders(opts.token);
    const limit = opts.limit ?? 50;
    const win = parseWindow(opts.since as string | undefined, opts.until as string | undefined);
    if (!win.ok) return refusedRead({ platform: 'notion', requested: limit, scope: 'team', detail: win.detail });
    if (opts.pages && opts.pages.length > 0) return this.fetchSubtrees(opts, opts.pages, headers, limit, win);
    const window = new DescendingWindow(win.sinceMs, win.untilMs);
    const startedAt = Date.now();
    const resolveUser = makeNotionUserResolver(headers);
    const items: FetcherItem[] = [];
    let scanned = 0;
    let bodiesUnreadable = 0;
    let bodiesCut = 0;
    const blockCap = capOption('maxBlockPages', opts.maxBlockPages, NOTION_MAX_BLOCK_PAGES, NOTION_BLOCK_PAGE_CEILING);
    const maxBlockPages = blockCap.value;
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
        redirect: 'manual',
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
    skips.push(...optionSkips([blockCap]));
    // Read to the end, or to the first page older than `since`, with nothing the limit cut.
    const exhausted = (reachedSince || cursor === undefined) && !cutByLimit && !outOfTime;
    return { items, report: buildFetchReport(items, { platform: 'notion', scanned, requested: limit, skips, scope: 'team', untilMs: win.untilMs, exhausted }) };
  }
}
