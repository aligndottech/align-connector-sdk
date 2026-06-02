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
