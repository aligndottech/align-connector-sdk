/**
 * Narrowing a Notion or Confluence read to the part that relates to one repo.
 *
 * Test List:
 * - Notion `pages` reads the named pages and their descendant child pages and child-database
 *   pages, and never calls /v1/search or any page outside that subtree.
 * - A dashed uuid is read as its 32-hex form.
 * - `limit` cuts the read (incomplete); `since`/`until` filter client-side but a dropped page's
 *   children are still visited, because a tree is not sorted by edit time.
 * - An unreadable id is an `error` skip naming it; the rest is read. A bad token still throws.
 * - An invalid id is refused before any request (a `shape` skip, nothing read).
 * - The time budget stops the walk with a `time_budget` skip.
 * - Confluence `ancestors` reads the named pages and their descendants with one CQL search
 *   (`ancestor in (...) OR id in (...)`), newest modified first, through the same window.
 * - It works with `spaces` (a `space in (...)` clause) and without; no v2 space lookup is made.
 * - An unreadable ancestor id is an `error` skip and is left out of the CQL; none readable means
 *   no search at all. An invalid id (not digits) is refused before any request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { NotionFetcher } from '../fetchers/notion.js';
import { ConfluenceFetcher } from '../fetchers/confluence.js';
import { serve } from './helpers/statusFetch.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const ROOT = '0123456789abcdef0123456789abcdef';
const CHILD = 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb';
const GRAND = 'cccccccccccccccc1111111111111111';
const DB = 'dddddddddddddddd2222222222222222';
const DBPAGE = 'eeeeeeeeeeeeeeee3333333333333333';
const OUTSIDE = 'ffffffffffffffff4444444444444444';
const MISSING = '99999999999999999999999999999999';
const dashed = (id: string) => `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
const NEW = '2026-05-11T08:00:00.000Z';
const OLD = '2026-05-01T08:00:00.000Z';
const SINCE = '2026-05-10T00:00:00.000Z';

const page = (id: string, title: string, edited = NEW) => ({
  object: 'page',
  id,
  url: `https://www.notion.so/${title}-${id}`,
  created_time: '2026-01-01T00:00:00.000Z',
  last_edited_time: edited,
  properties: { title: { title: [{ plain_text: title }] } },
});
const blocks = (...children: Array<{ type: 'child_page' | 'child_database'; id: string }>) => ({
  results: [
    { type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'body' }] } },
    ...children.map((c) => ({ type: c.type, id: dashed(c.id), [c.type]: { title: 'x' } })),
  ],
  has_more: false,
});
const gone = { __status: 404, body: { object: 'error', code: 'object_not_found' } };

/** ROOT holds CHILD (which holds GRAND) and the database DB (which holds DBPAGE). */
function tree(over: Record<string, unknown> = {}) {
  return serve(mockFetch, {
    [`/v1/pages/${ROOT}`]: page(ROOT, 'Root'),
    [`/v1/blocks/${ROOT}/children`]: blocks({ type: 'child_page', id: CHILD }, { type: 'child_database', id: DB }),
    [`/v1/pages/${CHILD}`]: page(CHILD, 'Child'),
    [`/v1/blocks/${CHILD}/children`]: blocks({ type: 'child_page', id: GRAND }),
    [`/v1/pages/${GRAND}`]: page(GRAND, 'Grand'),
    [`/v1/blocks/${GRAND}/children`]: blocks(),
    [`/v1/databases/${DB}/query`]: { results: [page(DBPAGE, 'DbPage')], has_more: false },
    [`/v1/blocks/${DBPAGE}/children`]: blocks(),
    '/v1/search': { results: [page(OUTSIDE, 'Outside')], has_more: false },
    [`/v1/pages/${OUTSIDE}`]: page(OUTSIDE, 'Outside'),
    ...over,
  });
}

describe('NotionFetcher pages', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('reads only the named subtree: child pages and child-database pages, never search or an outside page', async () => {
    const { calls, unmatched } = tree();
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT], limit: 100 });
    expect(unmatched).toEqual([]);
    expect(items.map((i) => i.title)).toEqual(['Root', 'Child', 'DbPage', 'Grand']);
    expect(calls.some((c) => c.url.endsWith('/v1/search'))).toBe(false);
    expect(calls.some((c) => c.url.includes(OUTSIDE))).toBe(false);
    expect(report).toMatchObject({ complete: true, scope: 'team', scanned: 4 });
  });

  it('reads a dashed uuid as its 32-hex form and a database id as a database', async () => {
    const { calls } = tree({ [`/v1/pages/${DB}`]: gone });
    const { items } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [dashed(DB)], limit: 100 });
    expect(items.map((i) => i.title)).toEqual(['DbPage']);
    expect(calls.map((c) => c.url)).toContain(`https://api.notion.com/v1/pages/${DB}`);
  });

  it('limit cuts the read and says so; pages past it are never requested', async () => {
    const { calls } = tree();
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT], limit: 2 });
    expect(items.map((i) => i.title)).toEqual(['Root', 'Child']);
    expect(report.complete).toBe(false);
    expect(calls.some((c) => c.url.includes(GRAND) || c.url.includes(DBPAGE))).toBe(false);
  });

  it('since drops an old page but still reads its children', async () => {
    tree({ [`/v1/pages/${CHILD}`]: page(CHILD, 'Child', OLD) });
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT], since: SINCE, limit: 100 });
    expect(items.map((i) => i.title)).toEqual(['Root', 'DbPage', 'Grand']);
    expect(report.complete).toBe(true);
  });

  it('until drops a page at or after it', async () => {
    tree({ [`/v1/pages/${CHILD}`]: page(CHILD, 'Child', OLD) });
    const { items } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT], until: SINCE, limit: 100 });
    expect(items.map((i) => i.title)).toEqual(['Child']);
  });

  it('an unreadable id is an error skip naming it, and the rest is still read', async () => {
    tree({ [`/v1/pages/${MISSING}`]: gone, [`/v1/databases/${MISSING}/query`]: gone });
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [MISSING, ROOT], limit: 100 });
    expect(items).toHaveLength(4);
    expect(report.complete).toBe(false);
    const skip = report.skips.find((s) => s.kind === 'error');
    expect(skip).toMatchObject({ count: 1 });
    expect(skip!.detail).toContain(MISSING);
  });

  it('a refused token still throws: it is not an unreadable id', async () => {
    tree({ [`/v1/pages/${ROOT}`]: { __status: 401, body: { code: 'unauthorized' } } });
    await expect(new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT] })).rejects.toThrow(/Notion/);
  });

  it.each([['not-an-id'], ['0123456789abcdef0123456789abcde'], [`${ROOT}/../x`]])('refuses the invalid id %s before any request', async (bad) => {
    const { calls } = tree();
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT, bad], limit: 100 });
    expect(calls).toEqual([]);
    expect(items).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.skips).toEqual([expect.objectContaining({ kind: 'shape', count: 1 })]);
    expect(report.skips[0]!.detail).toContain(bad);
  });

  it('an id given twice, or reached again as a descendant, is read once', async () => {
    const { calls } = tree();
    const { items } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT, dashed(ROOT), CHILD], limit: 100 });
    expect(items).toHaveLength(4);
    expect(calls.filter((c) => c.url.endsWith(`/v1/pages/${CHILD}`))).toHaveLength(1);
  });

  it('a database read that fails with 429 or 5xx after its first page throws, never a silent short read', async () => {
    for (const status of [429, 503]) {
      mockFetch.mockReset();
      tree({
        [`/v1/databases/${DB}/query`]: { results: [page(DBPAGE, 'DbPage')], has_more: true, next_cursor: 'C2' },
        [`/v1/databases/${DB}/query & C2`]: { __status: status, body: { code: 'x' } },
        [`/v1/pages/${DB}`]: gone,
      });
      await expect(new NotionFetcher().fetchWithReport({ token: 't', pages: [DB], limit: 100 })).rejects.toThrow(/Notion/);
    }
  });

  it('a database read that is refused (403/404) after its first page is an error skip, and the read is incomplete', async () => {
    tree({
      [`/v1/databases/${DB}/query`]: { results: [page(DBPAGE, 'DbPage')], has_more: true, next_cursor: 'C2' },
      [`/v1/databases/${DB}/query & C2`]: gone,
      [`/v1/pages/${DB}`]: gone,
    });
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [DB], limit: 100 });
    expect(items.map((i) => i.title)).toEqual(['DbPage']);
    expect(report.complete).toBe(false);
    expect(report.skips.find((s) => s.kind === 'error')!.detail).toContain(DB);
  });

  it('a window-dropped page whose body could not be read still makes the read incomplete', async () => {
    tree({ [`/v1/pages/${CHILD}`]: page(CHILD, 'Child', OLD), [`/v1/blocks/${CHILD}/children`]: { __status: 500, body: {} } });
    const { report } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT], since: SINCE, limit: 100 });
    expect(report.complete).toBe(false);
    expect(report.skips.some((s) => s.kind === 'error' && /body could not be read/.test(s.detail))).toBe(true);
  });

  it('a window-dropped page whose blocks were cut at maxBlockPages still reports page_cap', async () => {
    tree({
      [`/v1/pages/${CHILD}`]: page(CHILD, 'Child', OLD),
      [`/v1/blocks/${CHILD}/children`]: { ...blocks(), has_more: true, next_cursor: 'N' },
    });
    const { report } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT], since: SINCE, limit: 100, maxBlockPages: 1 });
    expect(report.complete).toBe(false);
    expect(report.skips.some((s) => s.kind === 'page_cap')).toBe(true);
  });

  it('the time budget fires even while the window matches nothing', async () => {
    tree();
    let now = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (now += 10));
    try {
      const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT], until: '2026-01-02T00:00:00Z', limit: 100, timeBudgetMs: 5 });
      expect(items).toEqual([]);
      expect(report.skips.some((s) => s.kind === 'time_budget')).toBe(true);
      expect(report.complete).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it('a 429 or 5xx on a page lookup throws and never falls through to the database query', async () => {
    for (const status of [429, 500]) {
      mockFetch.mockReset();
      const { calls } = tree({ [`/v1/pages/${ROOT}`]: { __status: status, body: { code: 'x' } } });
      await expect(new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT] })).rejects.toThrow(/Notion/);
      expect(calls.some((c) => c.url.includes('/databases/'))).toBe(false);
    }
  });

  it('a 400 on the page lookup (the id is a database) falls through to the database query', async () => {
    tree({ [`/v1/pages/${DB}`]: { __status: 400, body: { code: 'validation_error' } } });
    const { items } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [DB], limit: 100 });
    expect(items.map((i) => i.title)).toEqual(['DbPage']);
  });

  it('nested blocks that may hold child pages (toggle, column, callout) are not descended and are said so', async () => {
    tree({
      [`/v1/blocks/${ROOT}/children`]: { results: [{ type: 'toggle', id: 'b1', has_children: true, toggle: { rich_text: [] } }], has_more: false },
    });
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT], limit: 100 });
    expect(items.map((i) => i.title)).toEqual(['Root']);
    expect(report.skips).toContainEqual(expect.objectContaining({ kind: 'shape', count: 1, detail: expect.stringContaining('toggles, columns') }));
  });

  it('the time budget stops the walk with a time_budget skip', async () => {
    tree();
    let now = 1_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => (now += 10));
    try {
      const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', pages: [ROOT], limit: 100, timeBudgetMs: 5 });
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThan(4);
      expect(report.skips.some((s) => s.kind === 'time_budget')).toBe(true);
      expect(report.complete).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

const cfPage = (id: string, title: string, modified: string) => ({
  id,
  title,
  history: { createdBy: { accountId: 'acc' } },
  version: { when: modified },
  body: { storage: { value: `<p>${title} body</p>` } },
  _links: { webui: `/spaces/ENG/pages/${id}/${title}` },
});
const OAUTH = { token: 't', cloudId: 'cid', siteBase: 'https://acme.atlassian.net' };
const SEARCH = '/rest/api/content/search';
const found = (results: unknown[], next?: string) => ({ results, _links: { base: 'https://acme.atlassian.net/wiki', ...(next ? { next } : {}) } });
const searchCalls = (calls: Array<{ url: string }>) => calls.filter((c) => c.url.includes(SEARCH));
const cqlOf = (url: string) => new URL(url).searchParams.get('cql')!;

describe('ConfluenceFetcher ancestors', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  function routes(over: Record<string, unknown> = {}) {
    return serve(mockFetch, {
      '/api/v2/pages/100': { id: '100', title: 'Root', spaceId: '7' },
      '/api/v2/pages/200': { id: '200', title: 'Other root', spaceId: '9' },
      '/api/v2/spaces?keys=': { results: [{ id: '7', key: 'ENG' }, { id: '8', key: 'OPS' }], _links: {} },
      '/api/v2/pages/999': { id: '999', title: 'Outside' },
      [SEARCH]: found([cfPage('100', 'Root', NEW), cfPage('101', 'Child', NEW)]),
      '/rest/api/user': { displayName: 'Ann' },
      ...over,
    });
  }

  it('reads the named pages and their descendants with one CQL search, and nothing else', async () => {
    const { calls, unmatched } = routes();
    const { items, report } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100', '200'], limit: 100 });
    expect(unmatched).toEqual([]);
    const search = searchCalls(calls);
    expect(search).toHaveLength(1);
    expect(cqlOf(search[0]!.url)).toBe('(ancestor in (100, 200) OR id in (100, 200)) AND type = page ORDER BY lastmodified DESC');
    expect(search[0]!.url).toContain('expand=');
    const allowed = [/\/api\/v2\/pages\/(100|200)$/, /\/rest\/api\/content\/search\?/, /\/rest\/api\/user\?/];
    expect(calls.filter((c) => !allowed.some((re) => re.test(c.url)))).toEqual([]);
    expect(items.map((i) => i.title)).toEqual(['Root', 'Child']);
    expect(items[0]).toMatchObject({
      source_url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/100/Root',
      source_key: expect.any(String),
      updated_at: NEW,
      author: { name: 'Ann' },
    });
    expect(report).toMatchObject({ complete: true, scope: 'team', scanned: 2 });
  });

  it('with spaces, adds a space clause (keys resolved once, no per-space page listing)', async () => {
    const { calls } = routes();
    await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100'], spaces: ['ENG', 'OPS'], limit: 100 });
    expect(cqlOf(searchCalls(calls)[0]!.url)).toBe('(ancestor in (100) OR id in (100)) AND space in ("ENG", "OPS") AND type = page ORDER BY lastmodified DESC');
    expect(calls.filter((c) => c.url.includes('/api/v2/spaces'))).toHaveLength(1);
    expect(calls.some((c) => /\/api\/v2\/spaces\/\d+\/pages/.test(c.url))).toBe(false);
  });

  it('a named root outside the given spaces is an error skip naming it, and is left out of the search', async () => {
    const { calls } = routes();
    const { report } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100', '200'], spaces: ['ENG'], limit: 100 });
    expect(cqlOf(searchCalls(calls)[0]!.url)).toContain('ancestor in (100) OR id in (100)');
    const skip = report.skips.find((s) => s.kind === 'error');
    expect(skip!.detail).toContain('200');
    expect(report.complete).toBe(false);
  });

  it.each([429, 500, 503])('a %i on the page check throws; only 403 and 404 are a skip', async (status) => {
    routes({ '/api/v2/pages/100': { __status: status, body: {} } });
    await expect(new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100'], limit: 100 })).rejects.toThrow(/Confluence/);
  });

  it('refuses a space key that could leave its quotes before any request', async () => {
    const { calls } = routes();
    const { report } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100'], spaces: ['ENG") OR (space = "SECRET'] });
    expect(calls).toEqual([]);
    expect(report.skips[0]).toMatchObject({ kind: 'shape' });
  });

  it('since stops at the first page before it; limit cuts the read and says so', async () => {
    routes({ [SEARCH]: found([cfPage('101', 'A', NEW), cfPage('102', 'B', OLD), cfPage('103', 'C', OLD)]) });
    const since = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100'], since: SINCE, limit: 100 });
    expect(since.items.map((i) => i.title)).toEqual(['A']);
    expect(since.report.complete).toBe(true);
    routes({ [SEARCH]: found([cfPage('101', 'A', NEW), cfPage('102', 'B', NEW)]) });
    const cut = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100'], limit: 1 });
    expect(cut.items.map((i) => i.title)).toEqual(['A']);
    expect(cut.report.complete).toBe(false);
  });

  it('follows the search cursor to the next page of results', async () => {
    const { calls } = routes({
      [SEARCH]: found([cfPage('101', 'A', NEW)], '/wiki/rest/api/content/search?cql=x&cursor=NEXT'),
      [`${SEARCH} & cursor=NEXT`]: found([cfPage('102', 'B', NEW)]),
    });
    const { items } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100'], limit: 100 });
    expect(items.map((i) => i.title)).toEqual(['A', 'B']);
    expect(searchCalls(calls)).toHaveLength(2);
  });

  it('an unreadable ancestor is an error skip, left out of the search; the rest is read', async () => {
    const { calls } = routes({ '/api/v2/pages/200': { __status: 404, body: {} } });
    const { items, report } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100', '200'], limit: 100 });
    expect(cqlOf(searchCalls(calls)[0]!.url)).toContain('ancestor in (100) OR id in (100)');
    expect(items).toHaveLength(2);
    expect(report.complete).toBe(false);
    const skip = report.skips.find((s) => s.kind === 'error');
    expect(skip).toMatchObject({ count: 1 });
    expect(skip!.detail).toContain('200');
  });

  it('with no readable ancestor there is no search', async () => {
    const { calls } = routes({ '/api/v2/pages/100': { __status: 403, body: {} } });
    const { items, report } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100'], limit: 100 });
    expect(searchCalls(calls)).toEqual([]);
    expect(items).toEqual([]);
    expect(report.complete).toBe(false);
  });

  it.each([['abc'], ['12 OR 1=1'], ['']])('refuses the invalid id %j before any request', async (bad) => {
    const { calls } = routes();
    const { items, report } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100', bad], limit: 100 });
    expect(calls).toEqual([]);
    expect(items).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.skips).toEqual([expect.objectContaining({ kind: 'shape', count: 1 })]);
  });

  it('an id given twice is looked up once', async () => {
    const { calls } = routes();
    await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, ancestors: ['100', '100'], limit: 100 });
    expect(calls.filter((c) => c.url.endsWith('/api/v2/pages/100'))).toHaveLength(1);
    expect(cqlOf(searchCalls(calls)[0]!.url)).toContain('ancestor in (100)');
  });
});
