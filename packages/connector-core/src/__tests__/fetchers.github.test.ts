import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { GitHubFetcher } from '../fetchers/github.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: async () => body }) as unknown as Awaited<ReturnType<typeof fetch>>;

describe('GitHubFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('returns merged PRs and commented issues with author = the user', async () => {
    mockFetch
      .mockResolvedValueOnce(json({ login: 'octocat' })) // /user
      .mockResolvedValueOnce(
        json({
          items: [
            {
              html_url: 'https://github.com/o/r/pull/1',
              title: 'Use Postgres',
              body: 'we will use postgres',
              state: 'closed',
              repository_url: 'https://api.github.com/repos/o/r',
              user: { login: 'octocat', html_url: 'https://github.com/octocat' },
            },
          ],
        }),
      ) // PR search
      .mockResolvedValueOnce(json({ items: [] })); // issue search

    const items = await new GitHubFetcher().fetch({ token: 'tok', limit: 10 });

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source_url: 'https://github.com/o/r/pull/1',
      platform: 'github',
      title: 'Use Postgres',
      author: { name: 'octocat', handle: 'octocat', url: 'https://github.com/octocat' },
    });
    expect(items[0].raw_text).toContain('Repo: o/r');
    // first call is the authenticated /user probe
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.github.com/user');
  });

  it('paginates the PR search across pages up to the limit', async () => {
    const pr = (i: number) => ({ html_url: `u${i}`, title: `t${i}`, body: '', state: 'closed', repository_url: '' });
    mockFetch
      .mockResolvedValueOnce(json({ login: 'me' })) // /user
      .mockResolvedValueOnce(json({ items: Array.from({ length: 100 }, (_, i) => pr(i)) })) // PR page 1 (full -> continue)
      .mockResolvedValueOnce(json({ items: [pr(100), pr(101)] })) // PR page 2 (partial -> stop)
      .mockResolvedValueOnce(json({ items: [] })); // commented-issues page 1 (empty)

    const items = await new GitHubFetcher().fetch({ token: 't', limit: 150 });

    expect(items).toHaveLength(102);
    expect(mockFetch.mock.calls[1][0]).toContain('page=1');
    expect(mockFetch.mock.calls[2][0]).toContain('page=2');
  });

  it('throws a helpful error when auth fails', async () => {
    mockFetch.mockResolvedValueOnce(json(null, false, 401));
    await expect(new GitHubFetcher().fetch({ token: 'bad' })).rejects.toThrow(/GitHub auth failed \(401\)/);
  });

  it('respects the limit across PRs + issues', async () => {
    mockFetch
      .mockResolvedValueOnce(json({ login: 'me' }))
      .mockResolvedValueOnce(
        json({ items: [{ html_url: 'u1', title: 't1', body: '', state: 'open', repository_url: '' }] }),
      )
      .mockResolvedValueOnce(
        json({ items: [{ html_url: 'u2', title: 't2', body: '', state: 'open' }] }),
      );
    const items = await new GitHubFetcher().fetch({ token: 't', limit: 1 });
    expect(items).toHaveLength(1);
  });
});
