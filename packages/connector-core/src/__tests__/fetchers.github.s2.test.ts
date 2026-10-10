/**
 * S2: two-tier GitHub (items first, discussion later under a request budget), team scope
 * on a named repo, `since`/`until` windows sliced under the 1,000-result search ceiling,
 * every cap as a skip, search pacing, and fetchOne for capture-from-URL.
 *
 * Responses are synthetic, shaped to GitHub's documented REST payloads
 * (https://docs.github.com/en/rest/search/search, .../issues/issues#get-an-issue).
 * No live call is made.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { GitHubFetcher, fetchGitHubDiscussion } from '../fetchers/github.js';
import { fakeClockForTests } from '../fetchers/util/pace.js';
import type { FetcherItem } from '../types/fetcher.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const res = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Awaited<
    ReturnType<typeof fetch>
  >;

const prRow = (n: number, over: Record<string, unknown> = {}) => ({
  html_url: `https://github.com/o/r/pull/${n}`,
  number: n,
  title: `PR ${n}`,
  body: `body ${n}`,
  state: 'open',
  created_at: '2026-03-01T10:00:00Z',
  updated_at: '2026-03-02T10:00:00Z',
  repository_url: 'https://api.github.com/repos/o/r',
  user: { login: 'ada', html_url: 'https://github.com/ada' },
  pull_request: { merged_at: null },
  ...over,
});
const issueRow = (n: number, over: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = prRow(n, { html_url: `https://github.com/o/r/issues/${n}`, title: `Issue ${n}`, ...over });
  delete row.pull_request; // an issue carries no pull_request key at all
  return row;
};

type SearchServer = (q: string, page: number, perPage: number) => { status?: number; body?: unknown };

interface Served {
  urls: string[];
  searches: () => string[];
  discussion: () => string[];
}

/** Route every request: /user, search pages (by decoded q), discussion endpoints, single gets. */
function serve(opts: {
  search?: SearchServer;
  single?: (path: string) => { status?: number; body?: unknown } | 'throw-timeout';
  onCall?: (url: string) => void;
}): Served {
  const urls: string[] = [];
  mockFetch.mockImplementation(async (input: unknown) => {
    if (input === undefined) return res({});
    const url = String(input);
    urls.push(url);
    opts.onCall?.(url);
    if (url === 'https://api.github.com/user') return res({ login: 'me' });
    if (url.includes('/search/issues')) {
      const q = decodeURIComponent(url.split('q=')[1]!.split('&')[0]!);
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
      const perPage = Number(url.match(/[?&]per_page=(\d+)/)?.[1] ?? 30);
      const out = opts.search?.(q, page, perPage) ?? { body: { total_count: 0, incomplete_results: false, items: [] } };
      return res(out.body ?? {}, out.status ?? 200);
    }
    if (/\/(issues|pulls)\/\d+\/(comments|reviews)/.test(url)) {
      return res([{ body: `said on ${url.split('/repos/')[1]}`, user: { login: 'bob' }, created_at: '2026-03-03T00:00:00Z' }]);
    }
    if (opts.single) {
      const out = opts.single(url.replace('https://api.github.com', ''));
      if (out === 'throw-timeout') throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      return res(out.body ?? {}, out.status ?? 200);
    }
    throw new Error(`unrouted ${url}`);
  });
  return {
    urls,
    searches: () => urls.filter((u) => u.includes('/search/issues')).map((u) => decodeURIComponent(u.split('q=')[1]!.split('&')[0]!)),
    discussion: () => urls.filter((u) => /\/(issues|pulls)\/\d+\/(comments|reviews)/.test(u)),
  };
}

/** A search page cut from `total` synthetic rows keyed by query, so slices stay distinct. */
function pageOf(q: string, total: number, page: number, perPage: number, row = prRow) {
  const start = (page - 1) * perPage;
  const n = Math.max(0, Math.min(perPage, total - start, 1000 - start));
  const seed = [...q].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 100_000, 7) * 10_000;
  return { total_count: total, incomplete_results: false, items: Array.from({ length: n }, (_, i) => row(seed + start + i)) };
}

describe('GitHub two-tier fetch (Decision 27)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it("discussion: 'none' reads items from search alone: 250 PRs in 3 search pages, no discussion call, all detail_pending", async () => {
    const s = serve({
      search: (q, page, perPage) => ({ body: q.includes('type:pr') ? pageOf(q, 250, page, perPage) : pageOf(q, 0, page, perPage) }),
    });
    const { items, report } = await new GitHubFetcher().fetchWithReport({
      token: 't',
      limit: 1000,
      repo: 'o/r',
      scope: 'team',
      discussion: 'none',
    });
    expect(items).toHaveLength(250);
    expect(s.searches().filter((q) => q.includes('type:pr'))).toHaveLength(3);
    expect(s.discussion()).toEqual([]);
    expect(items.every((i) => i.detail_pending === true)).toBe(true);
    expect(report.complete).toBe(true);
  });

  it("discussion: 'full' (the default) fetches each item's discussion and leaves nothing pending", async () => {
    const s = serve({
      search: (q, page, perPage) => ({ body: q.includes('type:pr') ? pageOf(q, 2, page, perPage) : pageOf(q, 0, page, perPage) }),
    });
    const items = await new GitHubFetcher().fetch({ token: 't', limit: 10, repo: 'o/r', scope: 'team' });
    expect(items).toHaveLength(2);
    expect(s.discussion()).toHaveLength(6); // 3 per PR
    expect(items.every((i) => !i.detail_pending)).toBe(true);
    expect(items[0]!.raw_text).toContain('## Comments');
  });

  it('every item carries the vendor updated_at and its source_key', async () => {
    serve({ search: (q, page, perPage) => ({ body: q.includes('type:pr') ? pageOf(q, 1, page, perPage) : pageOf(q, 0, page, perPage) }) });
    const { items, report } = await new GitHubFetcher().fetchWithReport({ token: 't', repo: 'o/r', scope: 'team', discussion: 'none' });
    expect(items[0]!.updated_at).toBe('2026-03-02T10:00:00.000Z');
    expect(items[0]!.source_key).toBe(items[0]!.source_url);
    expect(items[0]!.source_key).toMatch(/^https:\/\/github\.com\/o\/r\/pull\/\d+$/);
    expect(report.highWater).toBe('2026-03-02T10:00:00.000Z');
  });
});

describe('fetchGitHubDiscussion: the background drain under a request budget', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  const pending = (n: number, minutesAgo: number): FetcherItem => ({
    source_url: `https://github.com/o/r/pull/${n}`,
    platform: 'github',
    raw_text: `PR ${n}`,
    title: `PR ${n}`,
    updated_at: new Date(Date.UTC(2026, 2, 1) - minutesAgo * 60_000).toISOString(),
    detail_pending: true,
  });

  it('stops at the budget: 300 PRs at 3 requests each under 600 enriches 200 and skips 100', async () => {
    const s = serve({});
    const input = Array.from({ length: 300 }, (_, i) => pending(i + 1, i));
    const out = await fetchGitHubDiscussion(input, { token: 't', maxRequests: 600 });
    expect(s.discussion().length).toBeLessThanOrEqual(600);
    expect(out.requests).toBe(s.discussion().length);
    expect(out.items).toHaveLength(200);
    expect(out.skips).toEqual([{ kind: 'page_cap', count: 100, detail: expect.stringContaining('600') }]);
    // Newest first: the 200 enriched are the 200 most recently updated.
    expect(out.items.map((i) => i.source_url)).toContain('https://github.com/o/r/pull/1');
    expect(out.items.map((i) => i.source_url)).not.toContain('https://github.com/o/r/pull/300');
    expect(out.items[0]!.raw_text).toContain('## Code Reviews');
    expect(out.items.every((i) => i.detail_pending === false)).toBe(true);
  });

  it('enriches all of 50 with no skip', async () => {
    serve({});
    const out = await fetchGitHubDiscussion(
      Array.from({ length: 50 }, (_, i) => pending(i + 1, i)),
      { token: 't', maxRequests: 600 },
    );
    expect(out.items).toHaveLength(50);
    expect(out.skips).toEqual([]);
  });

  it('an issue costs one request, so issues are counted at their own price', async () => {
    const s = serve({});
    const issue = { ...pending(5, 0), source_url: 'https://github.com/o/r/issues/5' };
    const out = await fetchGitHubDiscussion([issue], { token: 't', maxRequests: 1 });
    expect(s.discussion()).toEqual(['https://api.github.com/repos/o/r/issues/5/comments?per_page=20']);
    expect(out.items).toHaveLength(1);
  });
});

describe('GitHub team scope on a named repo, and since', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  // The first of the current month: the window is one open-ended slice.
  const monthStart = `${new Date().toISOString().slice(0, 8)}01`;

  it("repo + scope 'team' + since searches the repo by updated date, with no involves:", async () => {
    const s = serve({});
    const { report } = await new GitHubFetcher().fetchWithReport({ token: 't', repo: 'o/r', scope: 'team', since: `${monthStart}T00:00:00Z` });
    expect(s.searches().sort()).toEqual([`repo:o/r+updated:>=${monthStart}+type:issue`, `repo:o/r+updated:>=${monthStart}+type:pr`]);
    expect(s.searches().join(' ')).not.toContain('involves:');
    expect(report.scope).toBe('team');
  });

  it("scope 'team' with no repo stays personal: involves: queries, scope 'yours'", async () => {
    const s = serve({});
    const { report } = await new GitHubFetcher().fetchWithReport({ token: 't', scope: 'team' });
    expect(s.searches()).toEqual(expect.arrayContaining(['involves:me+type:pr', 'reviewed-by:me+type:pr', 'involves:me+type:issue']));
    expect(report.scope).toBe('yours');
  });

  it('repo without team scope is the personal ALI-917 narrowing, with since added', async () => {
    const s = serve({});
    const { report } = await new GitHubFetcher().fetchWithReport({
      token: 't',
      repo: 'o/r',
      since: `${monthStart}T00:00:00Z`,
    });
    expect(s.searches()).toContain(`involves:me+type:pr+repo:o/r+updated:>=${monthStart}`);
    expect(report.scope).toBe('yours');
  });

  it('a 422 "cannot be searched" on the repo is an auth skip naming the repo, and no items', async () => {
    serve({
      search: () => ({
        status: 422,
        body: { message: 'Validation Failed', errors: [{ message: 'The listed users and repositories cannot be searched either because the resources do not exist or you do not have permission to view them.' }] },
      }),
    });
    const { items, report } = await new GitHubFetcher().fetchWithReport({ token: 't', repo: 'o/r', scope: 'team' });
    expect(items).toEqual([]);
    expect(report.skips).toEqual([{ kind: 'auth', count: 1, detail: expect.stringContaining('o/r') }]);
    expect(report.complete).toBe(false);
  });

  it('a 200 on the same search is no skip', async () => {
    serve({});
    const { report } = await new GitHubFetcher().fetchWithReport({ token: 't', repo: 'o/r', scope: 'team' });
    expect(report.skips).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it('a non-OK search page is an error skip, not a silent stop', async () => {
    serve({
      search: (q, page, perPage) =>
        q.includes('type:pr') && page === 2 ? { status: 502, body: { message: 'bad gateway' } } : { body: pageOf(q, q.includes('type:pr') ? 150 : 0, page, perPage) },
    });
    const { items, report } = await new GitHubFetcher().fetchWithReport({ token: 't', limit: 500, repo: 'o/r', scope: 'team', discussion: 'none' });
    expect(items).toHaveLength(100);
    expect(report.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringContaining('502') }]);
    expect(report.complete).toBe(false);
  });
});

describe('GitHub date slicing under the 1,000-result ceiling', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  /** Totals by the updated: range in the query. */
  function totals(byRange: Record<string, number>, fallback = 0): SearchServer {
    return (q, page, perPage) => {
      if (!q.includes('type:pr')) return { body: pageOf(q, 0, page, perPage) };
      const range = /updated:([^+]+)/.exec(q)?.[1] ?? '';
      return { body: pageOf(q, byRange[range] ?? fallback, page, perPage) };
    };
  }

  it('slices a window by calendar month', async () => {
    const s = serve({ search: totals({}, 0) });
    await new GitHubFetcher().fetch({ token: 't', repo: 'o/r', scope: 'team', since: '2026-01-15T00:00:00Z', until: '2026-03-10T00:00:00Z' });
    const prRanges = s.searches().filter((q) => q.includes('type:pr')).map((q) => /updated:([^+]+)/.exec(q)![1]);
    expect(prRanges).toEqual(['2026-03-01..2026-03-09', '2026-02-01..2026-02-28', '2026-01-15..2026-01-31']);
  });

  it('halves a month whose total_count is over 1,000 until each half is under it, with no skip', async () => {
    const s = serve({
      search: totals({ '2026-03-01..2026-03-31': 1400, '2026-03-01..2026-03-16': 700, '2026-03-17..2026-03-31': 700 }),
    });
    const { items, report } = await new GitHubFetcher().fetchWithReport({
      token: 't',
      limit: 5000,
      repo: 'o/r',
      scope: 'team',
      discussion: 'none',
      since: '2026-03-01T00:00:00Z',
      until: '2026-04-01T00:00:00Z',
    });
    const prRanges = new Set(s.searches().filter((q) => q.includes('type:pr')).map((q) => /updated:([^+]+)/.exec(q)![1]));
    expect(prRanges).toEqual(new Set(['2026-03-01..2026-03-31', '2026-03-17..2026-03-31', '2026-03-01..2026-03-16']));
    expect(items).toHaveLength(1400);
    expect(report.skips).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it('a one-day slice still over 1,000 is a vendor_cap skip for the rest', async () => {
    serve({ search: totals({ '2026-03-05..2026-03-05': 1300 }) });
    const { items, report } = await new GitHubFetcher().fetchWithReport({
      token: 't',
      limit: 5000,
      repo: 'o/r',
      scope: 'team',
      discussion: 'none',
      since: '2026-03-05T00:00:00Z',
      until: '2026-03-06T00:00:00Z',
    });
    expect(items).toHaveLength(1000);
    expect(report.skips).toEqual([{ kind: 'vendor_cap', count: 300, detail: expect.stringContaining('1,000') }]);
    expect(report.complete).toBe(false);
  });

  it('incomplete_results on a slice is a vendor_cap skip', async () => {
    serve({
      search: (q, page, perPage) => ({ body: { ...pageOf(q, q.includes('type:pr') ? 3 : 0, page, perPage), incomplete_results: q.includes('type:pr') } }),
    });
    const { report } = await new GitHubFetcher().fetchWithReport({
      token: 't',
      repo: 'o/r',
      scope: 'team',
      discussion: 'none',
      since: '2026-03-05T00:00:00Z',
      until: '2026-03-06T00:00:00Z',
    });
    expect(report.skips).toEqual([{ kind: 'vendor_cap', count: 1, detail: expect.stringContaining('incomplete_results') }]);
  });
});

describe('GitHub search pacing and time budget', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('never sends more than 30 search requests in any 60 s', async () => {
    const clock = fakeClockForTests();
    const stamps: number[] = [];
    serve({
      search: (q, page, perPage) => ({ body: pageOf(q, q.includes('type:pr') ? 1000 : 0, page, perPage) }),
      onCall: (u) => {
        if (u.includes('/search/issues')) stamps.push(clock.now());
      },
    });
    await new GitHubFetcher().fetch({
      token: 't',
      limit: 10_000,
      repo: 'o/r',
      scope: 'team',
      discussion: 'none',
      since: '2026-01-01T00:00:00Z',
      until: '2026-05-01T00:00:00Z',
      clock,
    });
    expect(stamps.length).toBeGreaterThan(30); // positive control: the window was really exercised
    expect(clock.slept.length).toBeGreaterThan(0);
    for (let i = 30; i < stamps.length; i++) expect(stamps[i]! - stamps[i - 30]!).toBeGreaterThanOrEqual(60_000);
  });

  it('stops at timeBudgetMs with a time_budget skip instead of sleeping through it', async () => {
    const clock = fakeClockForTests();
    serve({ search: (q, page, perPage) => ({ body: pageOf(q, q.includes('type:pr') ? 1000 : 0, page, perPage) }) });
    const { items, report } = await new GitHubFetcher().fetchWithReport({
      token: 't',
      limit: 10_000,
      repo: 'o/r',
      scope: 'team',
      discussion: 'none',
      since: '2026-01-01T00:00:00Z',
      until: '2026-05-01T00:00:00Z',
      timeBudgetMs: 30_000,
      clock,
    });
    expect(items.length).toBeGreaterThan(0);
    expect(report.skips).toEqual([expect.objectContaining({ kind: 'time_budget' })]);
    expect(report.complete).toBe(false);
    expect(clock.slept).toEqual([]);
  });

  it('with no budget pressure the same read has no time_budget skip', async () => {
    serve({ search: (q, page, perPage) => ({ body: pageOf(q, q.includes('type:pr') ? 5 : 0, page, perPage) }) });
    const { report } = await new GitHubFetcher().fetchWithReport({ token: 't', repo: 'o/r', scope: 'team', timeBudgetMs: 60_000, clock: fakeClockForTests() });
    expect(report.skips).toEqual([]);
  });
});

describe('GitHub fetchOne (capture from a URL)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('a PR URL returns one item with its real fields and discussion, mapped like an imported item', async () => {
    const s = serve({
      single: (path) =>
        path === '/repos/o/r/issues/12'
          ? { body: prRow(12, { title: 'Adopt Kafka', body: 'Because SQS ordering', pull_request: { merged_at: '2026-03-04T00:00:00Z' } }) }
          : { status: 404 },
    });
    const { item, skip } = await new GitHubFetcher().fetchOne('https://github.com/o/r/pull/12/files#diff-1', { token: 't' });
    expect(skip).toBeUndefined();
    expect(item).toMatchObject({
      source_url: 'https://github.com/o/r/pull/12',
      platform: 'github',
      title: 'Adopt Kafka',
      created_at: '2026-03-01T10:00:00.000Z',
      updated_at: '2026-03-02T10:00:00.000Z',
      source_key: 'https://github.com/o/r/pull/12',
      author: { name: 'ada', handle: 'ada', url: 'https://github.com/ada' },
    });
    expect(item!.raw_text).toContain('Because SQS ordering');
    expect(item!.raw_text).toContain('Status: merged');
    expect(item!.raw_text).toContain('## Code Reviews');
    expect(item!.detail_pending).toBeFalsy();
    expect(s.discussion()).toHaveLength(3);
  });

  it('an issue URL returns the issue with its comments', async () => {
    const s = serve({ single: (path) => (path === '/repos/o/r/issues/7' ? { body: issueRow(7, { title: 'Flaky nightly' }) } : { status: 404 }) });
    const { item } = await new GitHubFetcher().fetchOne('https://github.com/o/r/issues/7', { token: 't' });
    expect(item).toMatchObject({ title: 'Flaky nightly', source_key: 'https://github.com/o/r/issues/7' });
    expect(item!.raw_text).toContain('## Comments');
    expect(s.discussion()).toEqual(['https://api.github.com/repos/o/r/issues/7/comments?per_page=20']);
  });

  it('a 404 is an error skip and a 403 an auth skip, never a throw', async () => {
    serve({ single: () => ({ status: 404, body: { message: 'Not Found' } }) });
    expect(await new GitHubFetcher().fetchOne('https://github.com/o/r/pull/1', { token: 't' })).toEqual({
      skip: { kind: 'error', count: 1, detail: expect.stringContaining('404') },
    });
    serve({ single: () => ({ status: 403, body: { message: 'Forbidden' } }) });
    expect(await new GitHubFetcher().fetchOne('https://github.com/o/r/pull/1', { token: 't' })).toEqual({
      skip: { kind: 'auth', count: 1, detail: expect.stringContaining('403') },
    });
  });

  it('a timeout is a time_budget skip', async () => {
    serve({ single: () => 'throw-timeout' });
    const out = await new GitHubFetcher().fetchOne('https://github.com/o/r/pull/1', { token: 't', timeoutMs: 5 });
    expect(out.skip).toMatchObject({ kind: 'time_budget' });
  });

  it.each([
    'https://github.com/o/r/blob/main/x.ts',
    'https://github.com/o/r',
    'https://gitlab.com/o/r/pull/1',
    'https://evil.example/o/r/pull/1',
    'not a url',
  ])('%s is a shape skip with no request', async (url) => {
    const s = serve({});
    expect(await new GitHubFetcher().fetchOne(url, { token: 't' })).toEqual({ skip: { kind: 'shape', count: 1, detail: expect.any(String) } });
    expect(s.urls).toEqual([]);
  });
});

describe('GitHub search query injection', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it.each(['a/b repo:c/d', 'a/b+is:private', 'a/b&page=1', 'a/b#x', 'a', 'a/b/c', '/b', 'a/', 'a/b%2Bis:private', 'a/b\nrepo:c/d'])(
    'repo %j is refused as a shape skip: zero search calls, not complete',
    async (repo) => {
      const s = serve({});
      for (const scope of ['yours', 'team'] as const) {
        const { items, report } = await new GitHubFetcher().fetchWithReport({ token: 't', repo, scope });
        expect(items).toEqual([]);
        expect(report.complete).toBe(false);
        expect(report.skips).toEqual([{ kind: 'shape', count: 1, detail: expect.stringContaining('owner/repo') }]);
      }
      expect(s.searches()).toHaveLength(0);
    },
  );

  it('a valid repo still searches, and pages 2 and up differ from page 1', async () => {
    const s = serve({ search: (q, page, perPage) => ({ body: q.includes('type:pr') ? pageOf(q, 250, page, perPage) : pageOf(q, 0, page, perPage) }) });
    await new GitHubFetcher().fetchWithReport({ token: 't', limit: 250, repo: 'my-org/re.po_1', scope: 'team', discussion: 'none' });
    const prPages = s.urls.filter((u) => u.includes('/search/issues') && decodeURIComponent(u).includes('type:pr')).map((u) => u.match(/[?&]page=(\d+)/)![1]);
    expect(prPages).toEqual(['1', '2', '3']);
    expect(s.searches().every((q) => q.startsWith('repo:my-org/re.po_1+'))).toBe(true);
  });
});

describe('a discussion section GitHub fails to return', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  /** serve(), but every comments endpoint answers 500. */
  function serveWithBrokenComments(opts: Parameters<typeof serve>[0]) {
    const s = serve(opts);
    const inner = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (input: unknown, init?: unknown) =>
      String(input).includes('/comments') ? res({ message: 'boom' }, 500) : inner(input as never, init as never),
    );
    return s;
  }

  it('list fetch: the item is kept, marked detail_pending, with no partial discussion in raw_text', async () => {
    serveWithBrokenComments({ search: (q, page, perPage) => ({ body: pageOf(q, q.includes('type:issue') ? 1 : 0, page, perPage, issueRow) }) });
    const { items } = await new GitHubFetcher().fetchWithReport({ token: 't', limit: 5 });
    expect(items).toHaveLength(1);
    expect(items[0]!.detail_pending).toBe(true);
    expect(items[0]!.raw_text).not.toContain('## Comments');
  });

  it('fetchOne: the item comes back pending AND an error skip says its discussion was not read', async () => {
    serveWithBrokenComments({ single: () => ({ body: issueRow(7) }) });
    const out = await new GitHubFetcher().fetchOne('https://github.com/o/r/issues/7', { token: 't' });
    expect(out.item).toMatchObject({ source_url: 'https://github.com/o/r/issues/7', detail_pending: true });
    expect(out.skip).toMatchObject({ kind: 'error', count: 1, detail: expect.stringContaining('discussion') });
  });
});

describe('the discussion drain only touches items that are pending', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const itemOf = (over: Partial<FetcherItem>): FetcherItem => ({
    source_url: 'https://github.com/o/r/issues/7',
    platform: 'github',
    raw_text: 'Flaky\n\nStatus: open\n\n## Comments\n[bob] (x):\nalready here',
    title: 'Flaky',
    ...over,
  });

  it('detail_pending:false and absent: no request, nothing returned, raw_text untouched', async () => {
    const s = serve({});
    const done = itemOf({ detail_pending: false });
    const never = itemOf({});
    const before = done.raw_text;
    const out = await fetchGitHubDiscussion([done, never], { token: 't', maxRequests: 100 });
    expect(s.urls).toEqual([]);
    expect(out.items).toEqual([]);
    expect(out.requests).toBe(0);
    expect(done.raw_text).toBe(before);
  });

  it('a pending item is still drained, and the non-pending one beside it is not', async () => {
    const s = serve({});
    const out = await fetchGitHubDiscussion([itemOf({ detail_pending: true, raw_text: 'Flaky' }), itemOf({ source_url: 'https://github.com/o/r/issues/8', detail_pending: false })], {
      token: 't',
      maxRequests: 100,
    });
    expect(out.items.map((i) => i.source_url)).toEqual(['https://github.com/o/r/issues/7']);
    expect(s.discussion()).toHaveLength(1);
  });
});

describe('GitHub repo length and the empty repo', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it.each([`${'o'.repeat(40)}/r`, `o/${'r'.repeat(101)}`])('%j is over the owner (39) or repo (100) cap: shape skip, no search', async (repo) => {
    const s = serve({});
    const { report } = await new GitHubFetcher().fetchWithReport({ token: 't', repo });
    expect(report.complete).toBe(false);
    expect(report.skips[0]).toMatchObject({ kind: 'shape' });
    expect(s.searches()).toHaveLength(0);
  });

  it('the longest allowed owner and repo still search', async () => {
    const s = serve({});
    const repo = `${'o'.repeat(39)}/${'r'.repeat(100)}`;
    await new GitHubFetcher().fetchWithReport({ token: 't', repo });
    expect(s.searches().length).toBeGreaterThan(0);
    expect(s.searches().every((q) => q.includes(`repo:${repo}`))).toBe(true);
  });

  it("repo '' means no repo: the unscoped search runs, as with parseWindow's empty bounds", async () => {
    const s = serve({});
    const { report } = await new GitHubFetcher().fetchWithReport({ token: 't', repo: '', scope: 'team' });
    expect(report.scope).toBe('yours');
    expect(s.searches().length).toBeGreaterThan(0);
    expect(s.searches().join(' ')).not.toContain('repo:');
  });
});
