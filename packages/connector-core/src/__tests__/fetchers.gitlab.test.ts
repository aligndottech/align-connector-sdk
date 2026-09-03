import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { GitLabFetcher } from '../fetchers/gitlab.js';
import { FetcherAuthError } from '../fetchers/errors.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Awaited<ReturnType<typeof fetch>>;

describe('GitLabFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns merged MRs from the default gitlab.com host', async () => {
    mockFetch
      .mockResolvedValueOnce(json({ id: 42 })) // /user
      .mockResolvedValueOnce(
        json([{ web_url: 'https://gitlab.com/g/p/-/merge_requests/3', title: 'Adopt Kafka', description: 'queue', state: 'merged' }]),
      );

    const items = await new GitLabFetcher().fetch({ token: 'tok' });

    expect(items).toEqual([
      {
        source_url: 'https://gitlab.com/g/p/-/merge_requests/3',
        platform: 'gitlab',
        raw_text: 'Adopt Kafka\n\nqueue\n\nStatus: merged',
        title: 'Adopt Kafka',
      },
    ]);
    expect(mockFetch.mock.calls[0][0]).toBe('https://gitlab.com/api/v4/user');
    expect(mockFetch.mock.calls[1][0]).toContain('author_id=42');
  });

  it('honours a self-hosted domain', async () => {
    mockFetch.mockResolvedValueOnce(json({ id: 1 })).mockResolvedValueOnce(json([]));
    await new GitLabFetcher().fetch({ token: 't', domain: 'gitlab.example.com' });
    expect(mockFetch.mock.calls[0][0]).toBe('https://gitlab.example.com/api/v4/user');
  });

  it('a 403 names the status, GitLab\'s message and the read_api scope hint', async () => {
    mockFetch.mockResolvedValueOnce(json({ message: '403 Forbidden' }, false, 403));
    await expect(new GitLabFetcher().fetch({ token: 'bad' })).rejects.toThrow(/^GitLab API failed \(403\): 403 Forbidden\. .*read_api/);
  });

  it('a 401 is a typed FetcherAuthError carrying GitLab\'s message', async () => {
    mockFetch.mockResolvedValueOnce(json({ message: '401 Unauthorized' }, false, 401));
    const err = await new GitLabFetcher().fetch({ token: 'bad' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetcherAuthError);
    expect((err as Error).message).toMatch(/GitLab authentication failed \(401\): 401 Unauthorized/);
  });

  it('a 500 does not mention the token', async () => {
    mockFetch.mockResolvedValueOnce(json({ message: 'boom' }, false, 500));
    await expect(new GitLabFetcher().fetch({ token: 'ok' })).rejects.toThrow(/^GitLab API failed \(500\): boom\.$/);
  });
});

describe('GitLabFetcher pagination and report (ALI-828)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const mr = (n: number) => ({ web_url: `https://gitlab.com/g/p/-/merge_requests/${n}`, title: `MR ${n}`, description: '', state: 'merged' });
  const mrs = (from: number, count: number) => Array.from({ length: count }, (_, i) => mr(from + i));
  const mrCalls = () => mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('merge_requests'));

  /** Serve a merged-MR list the way GitLab does: `page` is an offset in units of
   *  `per_page`, so a request that shrinks per_page on a later page moves the
   *  window backwards. A mock that ignores both parameters cannot see that. */
  const serveOffsetPaged = (all: ReturnType<typeof mr>[]) => {
    mockFetch.mockImplementation((async (input: unknown) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/user')) return json({ id: 42 });
      const perPage = Number(url.searchParams.get('per_page'));
      const page = Number(url.searchParams.get('page'));
      return json(all.slice((page - 1) * perPage, page * perPage));
    }) as never);
  };

  it('pages by page number with a constant per_page until the requested limit is reached', async () => {
    // R19a: GitLab's own max is 100 per page; 250 of 300 needs three requests, all at the same
    // per_page, and every item comes back exactly once (a fresh-context review found the first
    // cut shrinking per_page on the last page, which re-read MRs 101-150 and never reached 201-250).
    serveOffsetPaged(mrs(1, 300));
    const { items, report } = await new GitLabFetcher().fetchWithReport({ token: 'tok', limit: 250 });
    expect(items).toHaveLength(250);
    expect(new Set(items.map((i) => i.source_url)).size).toBe(250);
    expect(items[249].title).toBe('MR 250');
    const calls = mrCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('per_page=100&page=1');
    expect(calls[1]).toContain('per_page=100&page=2');
    expect(calls[2]).toContain('per_page=100&page=3');
    expect(report).toMatchObject({ platform: 'gitlab', requested: 250, scanned: 300, skips: [] });
  });

  it('asks for exactly the limit when it fits in one page', async () => {
    serveOffsetPaged(mrs(1, 300));
    const { items } = await new GitLabFetcher().fetchWithReport({ token: 'tok', limit: 40 });
    expect(items).toHaveLength(40);
    expect(mrCalls()).toEqual([expect.stringContaining('per_page=40&page=1')]);
  });

  it('stops after a page shorter than per_page', async () => {
    // R19b
    mockFetch.mockResolvedValueOnce(json({ id: 42 })).mockResolvedValueOnce(json(mrs(1, 40)));
    const { items, report } = await new GitLabFetcher().fetchWithReport({ token: 'tok', limit: 250 });
    expect(items).toHaveLength(40);
    expect(mrCalls()).toHaveLength(1);
    expect(report).toMatchObject({ platform: 'gitlab', requested: 250, scanned: 40 });
  });

  it('reports a merge-request page the token could not read instead of returning nothing silently', async () => {
    mockFetch.mockResolvedValueOnce(json({ id: 42 })).mockResolvedValueOnce(json({ message: '403 Forbidden' }, false, 403));
    const { items, report } = await new GitLabFetcher().fetchWithReport({ token: 'tok', limit: 50 });
    expect(items).toEqual([]);
    expect(report.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringContaining('merge request') }]);
  });
});
