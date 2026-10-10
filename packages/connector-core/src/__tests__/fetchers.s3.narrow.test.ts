/**
 * S3 narrow review pass (2026-10-10): N1..N5. Synthetic vendor responses only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { ZoomFetcher } from '../fetchers/zoom.js';
import { serve } from './helpers/statusFetch.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const authOf = (init: unknown) => ((init as { headers?: Record<string, string> } | undefined)?.headers ?? {}).Authorization;

describe('N1. Zoom transcript download follows Zoom redirects by hand, bounded', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const DL = 'https://zoom.us/rec/download/x';
  const VTT = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nhello\n';
  const meeting = {
    meetings: [{ id: 1, uuid: 'u1', topic: 't', start_time: new Date(Date.now() - 3_600_000).toISOString(), recording_files: [{ file_type: 'TRANSCRIPT', status: 'completed', download_url: DL }] }],
  };
  const read = () => new ZoomFetcher().fetchWithReport({ token: 'SECRET', daysBack: 1 });
  const downloads = () => mockFetch.mock.calls.filter(([u]) => !String(u).includes('/users/me/recordings'));

  it('302 to ssrweb.zoom.us: followed, the item is read, and the Bearer is NOT sent to the other host', async () => {
    serve(mockFetch, {
      '/users/me/recordings': meeting,
      [DL]: { __status: 302, headers: { location: 'https://ssrweb.zoom.us/file/signed?sig=abc' } },
      'https://ssrweb.zoom.us/file/signed': VTT,
    });
    const { items, report } = await read();
    expect(items).toHaveLength(1);
    expect(report.skips).toEqual([]);
    const d = downloads();
    expect(d.map(([u]) => String(u))).toEqual([DL, 'https://ssrweb.zoom.us/file/signed?sig=abc']);
    expect(authOf(d[0]![1])).toBe('Bearer SECRET');
    expect(authOf(d[1]![1])).toBeUndefined();
    for (const [, init] of d) expect((init as { redirect?: string }).redirect).toBe('manual');
  });

  it('a same-host hop keeps the Bearer; a relative Location resolves against the current URL', async () => {
    serve(mockFetch, {
      '/users/me/recordings': meeting,
      [DL]: { __status: 302, headers: { location: '/rec/download/y' } },
      'https://zoom.us/rec/download/y': VTT,
    });
    const { items } = await read();
    expect(items).toHaveLength(1);
    expect(authOf(downloads()[1]![1])).toBe('Bearer SECRET');
  });

  it.each(['https://evil.com/x', 'http://ssrweb.zoom.us/x', 'https://zoom.us.evil.com/x', 'https://u:p@ssrweb.zoom.us/x', ''])(
    'a Location of %j is never requested and is a counted error skip',
    async (location) => {
      serve(mockFetch, { '/users/me/recordings': meeting, [DL]: { __status: 302, headers: location ? { location } : {} }, 'evil.com': VTT });
      const { items, report } = await read();
      expect(items).toEqual([]);
      expect(downloads()).toHaveLength(1);
      expect(report.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringMatching(/redirect/) }]);
    },
  );

  it('more than 2 hops is a counted error skip after exactly 3 requests', async () => {
    serve(mockFetch, {
      '/users/me/recordings': meeting,
      [DL]: { __status: 302, headers: { location: 'https://zoom.us/h1' } },
      'https://zoom.us/h1': { __status: 302, headers: { location: 'https://zoom.us/h2' } },
      'https://zoom.us/h2': { __status: 302, headers: { location: 'https://zoom.us/h3' } },
      'https://zoom.us/h3': VTT,
    });
    const { items, report } = await read();
    expect(items).toEqual([]);
    expect(downloads()).toHaveLength(3);
    expect(report.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringMatching(/redirect/) }]);
  });
});
