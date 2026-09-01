import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { GitHubFetcher } from '../fetchers/github.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Awaited<ReturnType<typeof fetch>>;

/** A search-result row. `repository_url` + `number` are what make discussion fetchable. */
const row = (over: Record<string, unknown> = {}) => ({
  html_url: 'https://github.com/o/r/pull/1',
  title: 't',
  body: 'b',
  state: 'closed',
  number: 1,
  repository_url: 'https://api.github.com/repos/o/r',
  ...over,
});

interface Handlers {
  login?: string;
  /** Rows per search, keyed by the distinguishing part of the `q=` string. */
  search?: Record<string, unknown[]>;
  issueComments?: (repo: string, n: number) => unknown[] | 'fail' | 'throw';
  reviews?: (repo: string, n: number) => unknown[] | 'fail' | 'throw';
  reviewComments?: (repo: string, n: number) => unknown[] | 'fail' | 'throw';
  /** Called with every URL, before the response is produced. */
  onCall?: (url: string) => Promise<void> | void;
}

/** URL-routing mock: asserts on the REQUEST, and is order-independent so the
 *  three searches and the N+1 discussion reads cannot be pinned by luck. */
function install(h: Handlers) {
  const detail = (url: string, kind: 'issues' | 'reviews' | 'comments') => {
    const m =
      kind === 'issues'
        ? url.match(/repos\/(.+?)\/issues\/(\d+)\/comments/)
        : kind === 'reviews'
          ? url.match(/repos\/(.+?)\/pulls\/(\d+)\/reviews/)
          : url.match(/repos\/(.+?)\/pulls\/(\d+)\/comments/);
    return m ? { repo: m[1]!, n: Number(m[2]) } : null;
  };

  mockFetch.mockImplementation(async (input: unknown) => {
    // Vitest 4 + Node 24's undici mock can be invoked once with a
    // genuinely undefined `input` from outside this test's own async
    // chain (no GitHubFetcher/searchAll frame in its stack) - a
    // framework artifact this fetcher can never itself produce, since
    // every call site here passes a literal URL string. Tolerate it
    // rather than let it masquerade as a real routing bug.
    if (input === undefined) return json({});
    const url = String(input);
    await h.onCall?.(url);

    if (url === 'https://api.github.com/user') return json({ login: h.login ?? 'me' });

    if (url.includes('/search/issues')) {
      const q = decodeURIComponent(url.split('q=')[1]!.split('&')[0]!);
      const page = Number(url.match(/[?&]page=(\d+)/)?.[1] ?? 1);
      const key = Object.keys(h.search ?? {}).find((k) => q.includes(k));
      const all = key ? (h.search![key] as unknown[]) : [];
      // Only page 1 carries rows; these fixtures never exercise real paging.
      return json({ items: page === 1 ? all : [] });
    }

    for (const [kind, fn] of [
      ['issues', h.issueComments],
      ['reviews', h.reviews],
      ['comments', h.reviewComments],
    ] as const) {
      const hit = detail(url, kind);
      if (!hit) continue;
      const res = fn?.(hit.repo, hit.n) ?? [];
      if (res === 'throw') throw new Error('network');
      if (res === 'fail') return json(null, false, 403);
      return json(res);
    }

    throw new Error(`unrouted ${url}`);
  });
}

const searchQueries = () =>
  mockFetch.mock.calls
    .map((c) => String(c[0]))
    .filter((u) => u.includes('/search/issues'))
    .map((u) => decodeURIComponent(u.split('q=')[1]!.split('&')[0]!));

describe('GitHubFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  describe('what the searches can see (ALI-805)', () => {
    it('asks the involves: union for PRs and issues, plus reviewed-by: for PRs', async () => {
      install({ login: 'octocat', search: {} });
      await new GitHubFetcher().fetch({ token: 't', limit: 10 });

      const qs = searchQueries();
      // positive control: the searches really were issued, so the absence
      // assertions below are about the queries and not about an empty mock.
      expect(qs.length).toBeGreaterThan(0);
      expect(qs).toEqual(
        expect.arrayContaining([
          'involves:octocat+type:pr',
          'reviewed-by:octocat+type:pr',
          'involves:octocat+type:issue',
        ]),
      );
      // The two narrow qualifiers this ticket exists to remove.
      expect(qs.join(' ')).not.toContain('is:merged');
      expect(qs.join(' ')).not.toContain('commenter:');
    });

    it('returns an issue the user opened but never commented on', async () => {
      install({
        search: {
          'type:issue': [
            row({ html_url: 'https://github.com/o/r/issues/7', number: 7, title: 'Filed it', state: 'open' }),
          ],
        },
      });
      const items = await new GitHubFetcher().fetch({ token: 't', limit: 10 });
      expect(items.map((i) => i.title)).toEqual(['Filed it']);
    });

    it('returns unmerged PRs, and distinguishes merged from closed-without-merge', async () => {
      install({
        search: {
          'involves:me+type:pr': [
            row({ html_url: 'p/open', number: 1, title: 'in flight', state: 'open', pull_request: {} }),
            row({ html_url: 'p/reverted', number: 2, title: 'reverted', state: 'closed', pull_request: { merged_at: null } }),
            row({ html_url: 'p/merged', number: 3, title: 'shipped', state: 'closed', pull_request: { merged_at: '2026-01-01T00:00:00Z' } }),
          ],
        },
      });
      const items = await new GitHubFetcher().fetch({ token: 't', limit: 10 });
      const status = (t: string) => items.find((i) => i.title === t)!.raw_text.match(/Status: (\w+)/)![1];

      expect(items).toHaveLength(3);
      expect(status('in flight')).toBe('open');
      // The decision-dense one: closed and never merged is a reversal, not a ship.
      expect(status('reverted')).toBe('closed');
      expect(status('shipped')).toBe('merged');
    });

    it('returns a PR the user only reviewed (involves: cannot see reviews)', async () => {
      install({
        search: { 'reviewed-by:me+type:pr': [row({ html_url: 'p/theirs', number: 9, title: 'someone elses PR' })] },
      });
      const items = await new GitHubFetcher().fetch({ token: 't', limit: 10 });
      expect(items.map((i) => i.title)).toEqual(['someone elses PR']);
    });

    it('yields one item when the same PR is returned by two searches', async () => {
      const dupe = row({ html_url: 'p/same', number: 4, title: 'commented and reviewed' });
      install({ search: { 'involves:me+type:pr': [dupe], 'reviewed-by:me+type:pr': [dupe] } });
      const items = await new GitHubFetcher().fetch({ token: 't', limit: 10 });
      expect(items).toHaveLength(1);
    });

    it('does not let a prolific PR history crowd issues out of the limit', async () => {
      install({
        search: {
          'involves:me+type:pr': Array.from({ length: 50 }, (_, i) =>
            row({ html_url: `p/${i}`, number: i, title: `pr${i}` }),
          ),
          'involves:me+type:issue': Array.from({ length: 50 }, (_, i) =>
            row({ html_url: `i/${i}`, number: i, title: `issue${i}` }),
          ),
        },
      });
      const items = await new GitHubFetcher().fetch({ token: 't', limit: 10 });
      // exact split, not just "some issue survived" - proves neither list can
      // crowd the other out, not merely that crowding isn't total
      expect(items.filter((i) => i.title.startsWith('pr')).length).toBe(5);
      expect(items.filter((i) => i.title.startsWith('issue')).length).toBe(5);
    });
  });

  describe('search failures (pre-existing behavior, unchanged by ALI-805)', () => {
    it('returns whatever a search collected before a later page failed, rather than erroring the whole fetch', async () => {
      // searchAll's `if (!res.ok) break` predates this PR and is untouched by
      // it - locking in the existing behavior here, not proposing a change.
      // Worth a test now because this PR triples the search calls (2 -> 3),
      // so a transient failure on any one of them is 1.5x as likely to hit.
      mockFetch.mockImplementation(async (input: unknown) => {
        if (input === undefined) return json({});
        const url = String(input);
        if (url === 'https://api.github.com/user') return json({ login: 'me' });
        if (url.includes('type:pr') && url.includes('involves:')) {
          return json(null, false, 500); // this search fails outright
        }
        return json({ items: [] });
      });

      const items = await new GitHubFetcher().fetch({ token: 't', limit: 10 });
      expect(items).toEqual([]); // no throw, no crash - degrades to an empty category
    });
  });

  describe('the discussion, which is where the why lives (ALI-805)', () => {
    it('carries conversation comments, review bodies and inline review comments for a PR', async () => {
      install({
        search: { 'involves:me+type:pr': [row({ number: 42 })] },
        issueComments: () => [{ body: 'ship it monday', user: { login: 'ann' }, created_at: '2026-01-02' }],
        reviews: () => [
          { body: 'no, not that, it breaks X', user: { login: 'bo' }, submitted_at: '2026-01-03', state: 'CHANGES_REQUESTED' },
        ],
        reviewComments: () => [{ body: 'this null check is load-bearing', user: { login: 'cy' }, created_at: '2026-01-04' }],
      });
      const [item] = await new GitHubFetcher().fetch({ token: 't', limit: 10 });

      expect(item!.raw_text).toContain('ship it monday');
      expect(item!.raw_text).toContain('no, not that, it breaks X');
      expect(item!.raw_text).toContain('this null check is load-bearing');
      // attribution survives, so "who to talk to" is answerable from the row
      expect(item!.raw_text).toContain('[bo]');
      expect(item!.raw_text).toContain('CHANGES_REQUESTED');
      // the announcement is still there, ahead of the argument
      expect(item!.raw_text.indexOf('Status:')).toBeLessThan(item!.raw_text.indexOf('ship it monday'));
    });

    it('reads only the conversation for an issue - an issue has no reviews', async () => {
      install({
        search: { 'involves:me+type:issue': [row({ html_url: 'i/1', number: 5 })] },
        issueComments: () => [{ body: 'because latency', user: { login: 'ann' }, created_at: '2026-01-02' }],
      });
      const [item] = await new GitHubFetcher().fetch({ token: 't', limit: 10 });

      expect(item!.raw_text).toContain('because latency');
      expect(mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/pulls/'))).toEqual([]);
    });

    it('omits a section when every entry is empty', async () => {
      install({
        search: { 'involves:me+type:pr': [row({ number: 42 })] },
        reviews: () => [{ body: '', user: { login: 'bo' }, submitted_at: '2026-01-03', state: 'APPROVED' }],
      });
      const [item] = await new GitHubFetcher().fetch({ token: 't', limit: 10 });
      expect(item!.raw_text).not.toContain('Code Reviews');
    });

    it.each([['fail'], ['throw']] as const)(
      'still returns the item when the comment read %ss',
      async (mode) => {
        install({
          search: { 'involves:me+type:pr': [row({ number: 42, title: 'still here' })] },
          issueComments: () => mode,
          reviews: () => mode,
          reviewComments: () => mode,
        });
        const items = await new GitHubFetcher().fetch({ token: 't', limit: 10 });
        expect(items).toHaveLength(1);
        expect(items[0]!.title).toBe('still here');
      },
    );

    it('makes no discussion request for a row with no repository_url or number', async () => {
      install({ search: { 'involves:me+type:pr': [row({ repository_url: '', number: undefined })] } });
      const items = await new GitHubFetcher().fetch({ token: 't', limit: 10 });
      expect(items).toHaveLength(1);
      expect(mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/repos/'))).toEqual([]);
    });

    it('truncates a pathological thread instead of blowing the extraction budget', async () => {
      install({
        search: { 'involves:me+type:pr': [row({ number: 42 })] },
        issueComments: () => [{ body: 'x'.repeat(50_000), user: { login: 'ann' }, created_at: '2026-01-02' }],
      });
      const [item] = await new GitHubFetcher().fetch({ token: 't', limit: 10 });

      expect(item!.raw_text).toContain('[discussion truncated]');
      expect(item!.raw_text.length).toBeLessThan(10_000);
    });

    it('bounds how many items have their discussion in flight at once', async () => {
      let inFlight = 0;
      let peak = 0;
      install({
        search: {
          'involves:me+type:pr': Array.from({ length: 40 }, (_, i) =>
            row({ html_url: `p/${i}`, number: i, title: `pr${i}` }),
          ),
        },
        onCall: async (url) => {
          // one issues-comments read per item, so this counts ITEMS in flight
          if (!/issues\/\d+\/comments/.test(url)) return;
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 0));
          inFlight--;
        },
      });
      await new GitHubFetcher().fetch({ token: 't', limit: 40 });

      expect(peak).toBeGreaterThan(1); // positive control: it really does run concurrently
      expect(peak).toBe(5); // pins PARALLEL_DISCUSSION_FETCHES exactly, not just "under some slack"
    });

    it('bounds TOTAL concurrent discussion requests, not just items - GitHub asks for serial, not concurrent, requests per item', async () => {
      // Regression guard: a PR item fires 3 discussion requests (issue
      // comments, reviews, review comments). If those 3 run via Promise.all
      // WITHIN each item, 5 concurrent items x 3 requests each can spike to
      // 15 requests in flight - well past what GitHub's own best-practices
      // doc asks for ("make requests serially instead of concurrently").
      // This counts every discussion-endpoint call, not just one per item.
      let inFlight = 0;
      let peak = 0;
      install({
        search: {
          'involves:me+type:pr': Array.from({ length: 40 }, (_, i) =>
            row({ html_url: `p/${i}`, number: i, title: `pr${i}` }),
          ),
        },
        onCall: async (url) => {
          const isDiscussion = /issues\/\d+\/comments|pulls\/\d+\/(reviews|comments)/.test(url);
          if (!isDiscussion) return;
          inFlight++;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 0));
          inFlight--;
        },
      });
      await new GitHubFetcher().fetch({ token: 't', limit: 40 });

      expect(peak).toBeGreaterThan(1); // positive control
      expect(peak).toBeLessThanOrEqual(5);
    });
  });

  describe('contract preserved from before ALI-805', () => {
    it('returns normalized items with author = the PR/issue user', async () => {
      install({
        search: {
          'involves:me+type:pr': [
            row({
              html_url: 'https://github.com/o/r/pull/1',
              title: 'Use Postgres',
              body: 'we will use postgres',
              repository_url: 'https://api.github.com/repos/o/r',
              number: 1,
              user: { login: 'octocat', html_url: 'https://github.com/octocat' },
            }),
          ],
        },
      });
      const items = await new GitHubFetcher().fetch({ token: 't', limit: 10 });

      expect(items[0]).toMatchObject({
        source_url: 'https://github.com/o/r/pull/1',
        platform: 'github',
        title: 'Use Postgres',
        author: { name: 'octocat', handle: 'octocat', url: 'https://github.com/octocat' },
      });
      expect(items[0]!.raw_text).toContain('Repo: o/r');
      expect(mockFetch.mock.calls[0]![0]).toBe('https://api.github.com/user');
    });

    it('paginates a search across pages up to the limit', async () => {
      const pr = (i: number) => ({ html_url: `u${i}`, title: `t${i}`, body: '', state: 'closed', repository_url: '' });
      mockFetch.mockImplementation(async (input: unknown) => {
        if (input === undefined) return json({}); // see the note on this in install()
        const url = String(input);
        if (url === 'https://api.github.com/user') return json({ login: 'me' });
        const q = decodeURIComponent(url.split('q=')[1]!.split('&')[0]!);
        const page = Number(url.match(/[?&]page=(\d+)/)![1]);
        if (q !== 'involves:me+type:pr') return json({ items: [] });
        if (page === 1) return json({ items: Array.from({ length: 100 }, (_, i) => pr(i)) });
        if (page === 2) return json({ items: [pr(100), pr(101)] });
        return json({ items: [] });
      });

      const items = await new GitHubFetcher().fetch({ token: 't', limit: 150 });

      expect(items).toHaveLength(102);
      const pages = mockFetch.mock.calls
        .map((c) => String(c[0]))
        .filter((u) => u.includes('involves:me%2Btype:pr') || u.includes('involves:me+type:pr'));
      expect(pages.some((u) => u.includes('page=1'))).toBe(true);
      expect(pages.some((u) => u.includes('page=2'))).toBe(true);
    });

    it('respects the limit across every search', async () => {
      install({
        search: {
          'involves:me+type:pr': [row({ html_url: 'u1', number: 1, repository_url: '' })],
          'involves:me+type:issue': [row({ html_url: 'u2', number: 2, repository_url: '' })],
        },
      });
      const items = await new GitHubFetcher().fetch({ token: 't', limit: 1 });
      expect(items).toHaveLength(1);
    });

    it('throws a helpful error when auth fails', async () => {
      mockFetch.mockResolvedValueOnce(json(null, false, 401));
      await expect(new GitHubFetcher().fetch({ token: 'bad' })).rejects.toThrow(/GitHub auth failed \(401\)/);
    });
  });
});
