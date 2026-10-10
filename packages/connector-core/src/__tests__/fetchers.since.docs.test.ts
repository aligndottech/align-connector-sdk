/**
 * S3: `since`, cap reporting and `fetchOne` for the two document sources, Notion and
 * Confluence. Neither vendor offers a modified-since filter on the endpoint the fetcher
 * uses, so both sort newest first and stop client-side (DescendingWindow). Synthetic
 * vendor responses only: CI makes no live calls.
 *
 * Vendor docs: Notion search https://developers.notion.com/reference/post-search ;
 * Confluence v2 pages https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/
 * (sort=-modified-date, limit max 250) and spaces (keys=) .../api-group-space/ .
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { NotionFetcher } from '../fetchers/notion.js';
import { ConfluenceFetcher } from '../fetchers/confluence.js';
import { serve } from './helpers/statusFetch.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const D = '2026-05-10T00:00:00.000Z';
const AFTER = '2026-05-11T08:00:00.000Z';
const BEFORE = '2026-05-09T08:00:00.000Z';
const ID_A = '0123456789abcdef0123456789abcdef';
const ID_B = 'fedcba9876543210fedcba9876543210';
const ID_C = 'aaaaaaaaaaaaaaaabbbbbbbbbbbbbbbb';

const notionPage = (id: string, edited: string, title = `Page ${id.slice(0, 4)}`) => ({
  id,
  url: `https://www.notion.so/acme/${title.replace(/ /g, '-')}-${id}`,
  created_time: '2026-01-01T00:00:00.000Z',
  last_edited_time: edited,
  properties: { title: { title: [{ plain_text: title }] } },
});

describe('NotionFetcher since', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('sorts by last_edited_time descending and stops at the first page before since, which is not returned', async () => {
    const { calls, unmatched } = serve(mockFetch, {
      '/v1/search': { results: [notionPage(ID_A, AFTER), notionPage(ID_B, BEFORE)], has_more: true, next_cursor: 'C2' },
      '/v1/search & C2': { results: [notionPage(ID_C, AFTER)], has_more: false },
      '/v1/blocks/': { results: [] },
    });
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', since: D, limit: 100 });

    expect(unmatched).toEqual([]);
    const search = calls.filter((c) => c.url.endsWith('/v1/search'));
    expect(search).toHaveLength(1); // stopped: the cursor page was never asked for
    expect(JSON.parse(search[0].body).sort).toEqual({ timestamp: 'last_edited_time', direction: 'descending' });
    expect(items.map((i) => i.title)).toEqual([`Page ${ID_A.slice(0, 4)}`]);
    expect(items[0].updated_at).toBe(AFTER);
    expect(items[0].source_key).toBe(`https://www.notion.so/${ID_A}`);
    expect(report).toMatchObject({ complete: true, highWater: AFTER, scope: 'team' });
  });

  it('when every page is newer than since, paging continues to the end', async () => {
    const { calls } = serve(mockFetch, {
      '/v1/search': { results: [notionPage(ID_A, AFTER)], has_more: true, next_cursor: 'C2' },
      '/v1/search & C2': { results: [notionPage(ID_C, D)], has_more: false },
      '/v1/blocks/': { results: [] },
    });
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', since: D, limit: 100 });
    expect(calls.filter((c) => c.url.endsWith('/v1/search'))).toHaveLength(2);
    expect(items).toHaveLength(2);
    expect(report.complete).toBe(true);
  });

  it('an out-of-order result disables the stop: older pages are dropped, later newer ones kept, and the disorder is a counted skip', async () => {
    serve(mockFetch, {
      '/v1/search': { results: [notionPage(ID_A, AFTER), notionPage(ID_B, '2026-06-01T00:00:00.000Z'), notionPage(ID_C, BEFORE)], has_more: true, next_cursor: 'C2' },
      '/v1/search & C2': { results: [notionPage('11111111111111112222222222222222', AFTER)], has_more: false },
      '/v1/blocks/': { results: [] },
    });
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', since: D, limit: 100 });
    expect(items).toHaveLength(3);
    // Two inversions: 06-01 after 05-11, and the next page's 05-11 after 05-09.
    expect(report.skips).toContainEqual(expect.objectContaining({ kind: 'shape', count: 2, detail: expect.stringMatching(/out of last-modified order/) }));
  });

  it('a spent time budget stops the search and is a counted time_budget skip', async () => {
    serve(mockFetch, {
      '/v1/search': { results: [notionPage(ID_A, AFTER)], has_more: true, next_cursor: 'C2' },
      '/v1/blocks/': { results: [] },
    });
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => (t += 10_000));
    try {
      const { report } = await new NotionFetcher().fetchWithReport({ token: 't', limit: 100, timeBudgetMs: 5_000 });
      expect(report.skips).toContainEqual(expect.objectContaining({ kind: 'time_budget' }));
      expect(report.complete).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});

describe('NotionFetcher.fetchOne', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('reads the page and its first 50 blocks from the id at the end of the URL', async () => {
    const { calls } = serve(mockFetch, {
      [`/v1/pages/${ID_A}`]: notionPage(ID_A, AFTER, 'Spec'),
      [`/v1/blocks/${ID_A}/children?page_size=50`]: { results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'We use Postgres.' }] } }] },
    });
    const { item, skip } = await new NotionFetcher().fetchOne(`https://www.notion.so/acme/Spec-${ID_A}`, { token: 't' });
    expect(skip).toBeUndefined();
    expect(item).toMatchObject({
      platform: 'notion',
      title: 'Spec',
      updated_at: AFTER,
      source_key: `https://www.notion.so/${ID_A}`,
    });
    expect(item!.raw_text).toContain('We use Postgres.');
    expect(calls).toHaveLength(2);
  });

  it('a URL with no page id is a shape skip and no request', async () => {
    const { calls } = serve(mockFetch, {});
    const r = await new NotionFetcher().fetchOne('https://www.notion.so/acme/Some-Page', { token: 't' });
    expect(r).toEqual({ skip: expect.objectContaining({ kind: 'shape', count: 1 }) });
    expect(calls).toEqual([]);
  });

  it('a 404 is an error skip and a 401 an auth skip, never a throw', async () => {
    serve(mockFetch, { [`/v1/pages/${ID_A}`]: { __status: 404, body: { message: 'Could not find page' } } });
    expect((await new NotionFetcher().fetchOne(`https://www.notion.so/${ID_A}`, { token: 't' })).skip?.kind).toBe('error');
    mockFetch.mockReset();
    serve(mockFetch, { [`/v1/pages/${ID_A}`]: { __status: 401, body: { message: 'API token is invalid.' } } });
    expect((await new NotionFetcher().fetchOne(`https://www.notion.so/${ID_A}`, { token: 't' })).skip?.kind).toBe('auth');
  });

  it('a timeout is a time_budget skip', async () => {
    mockFetch.mockImplementation(async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    });
    const r = await new NotionFetcher().fetchOne(`https://www.notion.so/${ID_A}`, { token: 't', timeoutMs: 5 });
    expect(r.skip?.kind).toBe('time_budget');
  });
});

const OAUTH = { token: 't', cloudId: 'cid', siteBase: 'https://acme.atlassian.net' };
const cfPage = (id: string, modified: string, title = `Doc ${id}`) => ({
  id,
  title,
  authorId: undefined,
  version: { createdAt: modified },
  body: { storage: { value: `<p>${title} body</p>` } },
  _links: { webui: `/spaces/ENG/pages/${id}/${title.replace(/ /g, '+')}` },
});

describe('ConfluenceFetcher since and spaces', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('reads a selected space by id, sorted -modified-date with limit 250, and stops at the first page older than since', async () => {
    const { calls, unmatched } = serve(mockFetch, {
      '/api/v2/spaces?keys=ENG': { results: [{ id: '100', key: 'ENG' }] },
      '/api/v2/spaces/100/pages': {
        results: [cfPage('1', AFTER), cfPage('2', BEFORE)],
        _links: { base: 'https://acme.atlassian.net/wiki', next: '/wiki/api/v2/spaces/100/pages?cursor=NEXT' },
      },
      '/api/v2/spaces/100/pages & cursor=NEXT': { results: [cfPage('3', AFTER)], _links: { base: 'https://acme.atlassian.net/wiki' } },
    });
    const { items, report } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, spaces: ['ENG'], since: D, limit: 1000 });

    expect(unmatched).toEqual([]);
    const pageCalls = calls.filter((c) => c.url.includes('/pages'));
    expect(pageCalls).toHaveLength(1);
    expect(pageCalls[0].url).toContain('/api/v2/spaces/100/pages?sort=-modified-date&limit=250');
    expect(items.map((i) => i.title)).toEqual(['Doc 1']);
    expect(items[0]).toMatchObject({
      updated_at: AFTER,
      source_url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/1/Doc+1',
      source_key: 'https://acme.atlassian.net/wiki/pages/1',
    });
    expect(report).toMatchObject({ complete: true, highWater: AFTER, scope: 'team', perScope: { ENG: 1 } });
  });

  it('reads two spaces and counts items per space', async () => {
    serve(mockFetch, {
      '/api/v2/spaces?keys=ENG': { results: [{ id: '100', key: 'ENG' }, { id: '200', key: 'OPS' }] },
      '/api/v2/spaces/100/pages': { results: [cfPage('1', AFTER)], _links: {} },
      '/api/v2/spaces/200/pages': { results: [cfPage('2', AFTER), cfPage('3', D)], _links: {} },
    });
    const { items, report } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, spaces: ['ENG', 'OPS'], since: D, limit: 1000 });
    expect(items).toHaveLength(3);
    expect(report.perScope).toEqual({ ENG: 1, OPS: 2 });
    expect(report.complete).toBe(true);
  });

  it('a selected space the token cannot see is a counted error skip naming it, and the read is not complete', async () => {
    serve(mockFetch, {
      '/api/v2/spaces?keys=ENG': { results: [{ id: '100', key: 'ENG' }] },
      '/api/v2/spaces/100/pages': { results: [cfPage('1', AFTER)], _links: {} },
    });
    const { report } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, spaces: ['ENG', 'SECRET'], since: D, limit: 1000 });
    expect(report.skips).toContainEqual({ kind: 'error', count: 1, detail: expect.stringMatching(/SECRET/) });
    expect(report.complete).toBe(false);
  });

  it('with no spaces, the whole-visible listing is kept and now sorted -modified-date', async () => {
    const { calls } = serve(mockFetch, { '/api/v2/pages': { results: [cfPage('1', AFTER)], _links: {} } });
    await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, limit: 1000 });
    expect(calls[0].url).toContain('/api/v2/pages?sort=-modified-date&limit=250');
  });

  it('a spent time budget before the next space is a counted time_budget skip', async () => {
    serve(mockFetch, {
      '/api/v2/spaces?keys=ENG': { results: [{ id: '100', key: 'ENG' }, { id: '200', key: 'OPS' }] },
      '/api/v2/spaces/100/pages': { results: [cfPage('1', AFTER)], _links: {} },
      '/api/v2/spaces/200/pages': { results: [cfPage('2', AFTER)], _links: {} },
    });
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => (t += 10_000));
    try {
      const { report } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, spaces: ['ENG', 'OPS'], limit: 1000, timeBudgetMs: 5_000 });
      expect(report.skips).toContainEqual(expect.objectContaining({ kind: 'time_budget' }));
      expect(report.complete).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});

describe('ConfluenceFetcher.fetchOne', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('reads one page by the id in the URL', async () => {
    const { calls } = serve(mockFetch, {
      '/api/v2/pages/123?body-format=storage': { ...cfPage('123', AFTER, 'ADR 7'), _links: { webui: '/spaces/ENG/pages/123/ADR+7', base: 'https://acme.atlassian.net/wiki' } },
    });
    const { item, skip } = await new ConfluenceFetcher().fetchOne('https://acme.atlassian.net/wiki/spaces/ENG/pages/123/ADR+7', OAUTH);
    expect(skip).toBeUndefined();
    expect(item).toMatchObject({
      platform: 'confluence',
      title: 'ADR 7',
      updated_at: AFTER,
      source_url: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123/ADR+7',
      source_key: 'https://acme.atlassian.net/wiki/pages/123',
    });
    expect(item!.raw_text).toContain('ADR 7 body');
    expect(calls).toHaveLength(1);
  });

  it('a URL with no page id is a shape skip and no request', async () => {
    const { calls } = serve(mockFetch, {});
    const r = await new ConfluenceFetcher().fetchOne('https://acme.atlassian.net/wiki/spaces/ENG/overview', OAUTH);
    expect(r.skip?.kind).toBe('shape');
    expect(calls).toEqual([]);
  });

  it('a 403 is an auth skip and a 404 an error skip', async () => {
    serve(mockFetch, { '/api/v2/pages/123': { __status: 403, body: { message: 'no' } } });
    expect((await new ConfluenceFetcher().fetchOne('https://acme.atlassian.net/wiki/pages/123', OAUTH)).skip?.kind).toBe('auth');
    mockFetch.mockReset();
    serve(mockFetch, { '/api/v2/pages/123': { __status: 404, body: { message: 'gone' } } });
    expect((await new ConfluenceFetcher().fetchOne('https://acme.atlassian.net/wiki/pages/123', OAUTH)).skip?.kind).toBe('error');
  });
});
