import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { GitLabFetcher } from '../fetchers/gitlab.js';

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

  it('throws on auth failure', async () => {
    mockFetch.mockResolvedValueOnce(json(null, false, 403));
    await expect(new GitLabFetcher().fetch({ token: 'bad' })).rejects.toThrow(/GitLab auth failed \(403\)/);
  });
});

describe('GitLabFetcher pagination and report (ALI-828)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const mr = (n: number) => ({ web_url: `https://gitlab.com/g/p/-/merge_requests/${n}`, title: `MR ${n}`, description: '', state: 'merged' });
  const mrs = (from: number, count: number) => Array.from({ length: count }, (_, i) => mr(from + i));
  const mrCalls = () => mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('merge_requests'));

  it('pages by page number until the requested limit is reached', async () => {
    // R19a: GitLab's own max is 100 per page; 250 needs three requests and the last asks only for the remainder.
    mockFetch
      .mockResolvedValueOnce(json({ id: 42 }))
      .mockResolvedValueOnce(json(mrs(1, 100)))
      .mockResolvedValueOnce(json(mrs(101, 100)))
      .mockResolvedValueOnce(json(mrs(201, 50)));
    const { items, report } = await new GitLabFetcher().fetchWithReport({ token: 'tok', limit: 250 });
    expect(items).toHaveLength(250);
    const calls = mrCalls();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('per_page=100&page=1');
    expect(calls[1]).toContain('per_page=100&page=2');
    expect(calls[2]).toContain('per_page=50&page=3');
    expect(report).toMatchObject({ platform: 'gitlab', requested: 250, scanned: 250, skips: [] });
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
