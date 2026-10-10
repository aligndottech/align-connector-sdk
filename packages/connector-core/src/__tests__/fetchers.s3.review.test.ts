/**
 * S3 review round (2026-10-10): each describe pins one finding.
 * Synthetic vendor responses only; CI makes no live calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { TeamsFetcher } from '../fetchers/teams.js';
import { serve } from './helpers/statusFetch.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const offHost = (calls: Array<{ url: string }>) => calls.filter((c) => !c.url.startsWith('https://graph.microsoft.com/'));

describe('1. Teams sends its Bearer only to graph.microsoft.com', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const LIST = {
    '/me/joinedTeams': { value: [{ id: 'T1', displayName: 'P' }] },
    '/teams/T1/channels': { value: [{ id: 'C', displayName: 'G' }] },
  };
  const msg = { id: '1', lastModifiedDateTime: '2026-05-05T00:00:00Z', body: { content: 'x' }, webUrl: 'https://teams.microsoft.com/l/message/c/1' };

  it.each(['https://evil.com/steal', 'https://graph.microsoft.com.evil.com/v1.0/x', 'https://user@graph.microsoft.com/v1.0/x', 'http://graph.microsoft.com/v1.0/x'])(
    'the list read refuses next link %s: no request to it, a shape skip, not complete',
    async (link) => {
      const { calls } = serve(mockFetch, { ...LIST, '/teams/T1/channels/C/messages': { value: [msg], '@odata.nextLink': link }, 'evil.com': { value: [] } });
      const { items, report } = await new TeamsFetcher().fetchWithReport({ token: 'SECRET', limit: 50 });
      expect(calls.filter((c) => c.url === link)).toEqual([]);
      expect(offHost(calls)).toEqual([]);
      expect(items).toHaveLength(1); // the page already read is kept
      expect(report.skips).toEqual([{ kind: 'shape', count: 1, detail: expect.stringMatching(/next links? not on graph\.microsoft\.com/) }]);
      expect(report.complete).toBe(false);
    },
  );

  it('the list read follows an on-host next link (positive control) and never follows redirects', async () => {
    const { calls } = serve(mockFetch, {
      ...LIST,
      '/teams/T1/channels/C/messages': { value: [msg], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/teams/T1/channels/C/messages?$skiptoken=P2' },
      '/teams/T1/channels/C/messages & skiptoken=P2': { value: [] },
    });
    const { report } = await new TeamsFetcher().fetchWithReport({ token: 'SECRET', limit: 50 });
    expect(calls.some((c) => c.url.includes('skiptoken=P2'))).toBe(true);
    expect(report.complete).toBe(true);
    for (const [, init] of mockFetch.mock.calls) expect((init as { redirect?: string }).redirect).toBe('manual');
  });

  it('fetchOne refuses an off-host replies next link: no request to it, an error skip', async () => {
    const G = '11111111-2222-3333-4444-555555555555';
    const { calls } = serve(mockFetch, {
      '/messages/1/replies': { value: [], '@odata.nextLink': 'https://evil.com/steal' },
      '/messages/1': { id: '1', body: { content: 'x' } },
      'evil.com': { value: [] },
    });
    const out = await new TeamsFetcher().fetchOne(
      `https://teams.microsoft.com/l/message/${encodeURIComponent('19:a@thread.tacv2')}/1?groupId=${G}&teamName=a&channelName=b`,
      { token: 'SECRET' },
    );
    expect(offHost(calls)).toEqual([]);
    expect(out.skip?.kind).toBe('error');
  });
});
