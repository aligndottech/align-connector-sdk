/**
 * S3 narrow review pass (2026-10-10): N1..N5. Synthetic vendor responses only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { ZoomFetcher } from '../fetchers/zoom.js';
import { SlackFetcher } from '../fetchers/slack.js';
import { serve } from './helpers/statusFetch.js';
import { capOption } from '../fetchers/util/since.js';
import { TeamsFetcher } from '../fetchers/teams.js';
import { NotionFetcher } from '../fetchers/notion.js';
import { ConfluenceFetcher } from '../fetchers/confluence.js';

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

describe('N2. Slack threads trimmed at until are partial and counted', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const BASE = {
    'auth.test': { ok: true },
    'conversations.list': { ok: true, channels: [{ id: 'C1', name: 'g' }] },
    'users.info': { ok: true, user: { name: 'u' } },
    'conversations.history': { ok: true, messages: [{ ts: '1699990000.000000', reply_count: 2, user: 'U1', text: 'root' }] },
  };
  const read = () => new SlackFetcher().fetchWithReport({ token: 't', since: '2023-11-14T00:00:00Z', until: '2023-11-14T22:13:20.000Z', interChannelDelayMs: 0 });

  it('one reply after until: the thread item is partial and the report counts it', async () => {
    serve(mockFetch, {
      ...BASE,
      'conversations.replies': { ok: true, messages: [{ ts: '1699990000.000000', user: 'U1', text: 'root' }, { ts: '1699990001.000000', user: 'U1', text: 'in' }, { ts: '1700100000.000000', user: 'U1', text: 'after' }] },
    });
    const { items, report } = await read();
    expect(items[0]!.partial).toBe(true);
    expect(report.skips).toContainEqual({ kind: 'shape', count: 1, detail: expect.stringMatching(/after until/) });
  });

  it('no reply dropped: not partial and no count', async () => {
    serve(mockFetch, {
      ...BASE,
      'conversations.replies': { ok: true, messages: [{ ts: '1699990000.000000', user: 'U1', text: 'root' }, { ts: '1699990001.000000', user: 'U1', text: 'in' }] },
    });
    const { items, report } = await read();
    expect(items[0]).not.toHaveProperty('partial');
    expect(report.skips).toEqual([]);
  });
});

describe('N3. capOption: floored, clamped to a ceiling, and a fallback is said out loud', () => {
  it.each([
    [undefined, 3, undefined],
    [5, 5, undefined],
    [1.9, 1, undefined],
    [100, 100, undefined],
    [1e9, 100, /above the ceiling 100/],
    [0, 3, /not a whole number of at least 1/],
    [-1, 3, /not a whole number of at least 1/],
    [0.5, 3, /not a whole number of at least 1/],
    ['5', 3, /not a whole number of at least 1/],
    [Number.NaN, 3, /not a whole number of at least 1/],
    [Number.POSITIVE_INFINITY, 3, /not a whole number of at least 1/],
  ])('%s -> %s', (value, expected, note) => {
    const r = capOption('maxReplyPages', value, 3, 100);
    expect(r.value).toBe(expected);
    if (note) expect(r.note).toMatch(note);
    else expect(r.note).toBeUndefined();
    if (note) expect(r.note).toContain('maxReplyPages');
  });

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('Slack list: invalid maxChannels and maxHistoryPages fall back, read on, and one shape skip names both', async () => {
    const { calls } = serve(mockFetch, {
      'auth.test': { ok: true },
      'conversations.list': { ok: true, channels: [{ id: 'C1', name: 'a' }, { id: 'C2', name: 'b' }] },
      'conversations.history': { ok: true, messages: [], response_metadata: { next_cursor: 'P1' } },
      'conversations.history & cursor=P1': { ok: true, messages: [] },
    });
    const { report } = await new SlackFetcher().fetchWithReport({ token: 't', interChannelDelayMs: 0, maxChannels: Number.NaN, maxHistoryPages: 0 });
    expect(calls.filter((c) => c.url.includes('conversations.history'))).toHaveLength(4); // 2 channels x 2 pages: defaults applied
    const opt = report.skips.filter((k) => k.kind === 'shape');
    expect(opt).toEqual([{ kind: 'shape', count: 2, detail: expect.stringMatching(/maxChannels.*maxHistoryPages/) }]);
    expect(report.complete).toBe(true); // a fallback does not fail the read
  });

  it('Slack list: maxChannels 1e9 is clamped to 1000 and said', async () => {
    serve(mockFetch, { 'auth.test': { ok: true }, 'conversations.list': { ok: true, channels: [] } });
    const { report } = await new SlackFetcher().fetchWithReport({ token: 't', interChannelDelayMs: 0, maxChannels: 1e9 });
    expect(report.skips).toEqual([{ kind: 'shape', count: 1, detail: expect.stringMatching(/maxChannels .*above the ceiling 1000/) }]);
  });

  it('Teams list: an invalid maxMessagePages is said', async () => {
    serve(mockFetch, { '/me/joinedTeams': { value: [] } });
    const { report } = await new TeamsFetcher().fetchWithReport({ token: 't', maxMessagePages: '5' });
    expect(report.skips).toEqual([{ kind: 'shape', count: 1, detail: expect.stringMatching(/maxMessagePages/) }]);
  });

  it('Notion fetchOne: an invalid maxBlockPages is said beside the item', async () => {
    const ID = '0123456789abcdef0123456789abcdef';
    serve(mockFetch, { [`/v1/pages/${ID}`]: { id: ID, properties: {} }, '/v1/blocks/': { results: [] } });
    const out = await new NotionFetcher().fetchOne(`https://www.notion.so/${ID}`, { token: 't', maxBlockPages: -1 });
    expect(out.item).toBeDefined();
    expect(out.item).not.toHaveProperty('partial');
    expect(out.skips).toEqual([{ kind: 'shape', count: 1, detail: expect.stringMatching(/maxBlockPages/) }]);
  });
});

describe('N4. list reads and their lookups never follow a redirect', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const R302 = { __status: 302, headers: { location: 'https://evil.com/steal' } };
  const allManual = () => {
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0); // positive control for the loop below
    for (const [u, init] of mockFetch.mock.calls) {
      expect(String(u)).not.toContain('evil.com');
      expect((init as { redirect?: string } | undefined)?.redirect, String(u)).toBe('manual');
    }
  };

  it('Confluence: the page listing, the space lookup and the author lookup', async () => {
    serve(mockFetch, {
      '/api/v2/spaces?keys=': { results: [{ id: '1', key: 'ENG' }] },
      '/api/v2/spaces/1/pages': { results: [{ id: '9', title: 'A', authorId: 'acc', version: { createdAt: '2026-05-05T00:00:00Z' }, _links: { webui: '/p/9' } }], _links: {} },
      '/rest/api/user': R302,
    });
    const { items } = await new ConfluenceFetcher().fetchWithReport({ token: 't', cloudId: 'c', siteBase: 'https://acme.atlassian.net', spaces: ['ENG'] });
    expect(items[0]).not.toHaveProperty('author'); // the redirected lookup gave nothing
    allManual();
  });

  it('Confluence: a redirected page listing fails the read rather than following', async () => {
    serve(mockFetch, { '/api/v2/pages': R302 });
    await expect(new ConfluenceFetcher().fetchWithReport({ token: 't', cloudId: 'c', siteBase: 'https://acme.atlassian.net' })).rejects.toThrow(/302/);
    allManual();
  });

  it('Notion: search, blocks (a redirect is an unreadable body) and the user lookup', async () => {
    const ID = '0123456789abcdef0123456789abcdef';
    serve(mockFetch, {
      '/v1/search': { results: [{ id: ID, url: `https://www.notion.so/${ID}`, created_by: { id: 'u1' }, properties: {} }], has_more: false },
      '/v1/blocks/': R302,
      '/v1/users/': R302,
    });
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't' });
    expect(items[0]!.partial).toBe(true);
    expect(report.skips).toContainEqual(expect.objectContaining({ kind: 'error', count: 1 }));
    allManual();
  });

  it('Slack: a redirected channel history is a counted error skip, and every call is manual', async () => {
    serve(mockFetch, {
      'auth.test': { ok: true },
      'conversations.list': { ok: true, channels: [{ id: 'C1', name: 'a' }] },
      'conversations.history': R302,
    });
    const { report } = await new SlackFetcher().fetchWithReport({ token: 't', interChannelDelayMs: 0 });
    expect(report.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringMatching(/channels the token could not read/) }]);
    allManual();
  });

  it('Slack: a 3xx whose body looks like data is still refused, never read as an answer', async () => {
    serve(mockFetch, {
      'auth.test': { ok: true },
      'conversations.list': { ok: true, channels: [{ id: 'C1', name: 'a' }] },
      'conversations.history': { ...R302, body: { ok: true, messages: [{ ts: '1.000000', reply_count: 2, user: 'U1', text: 'x' }] } },
      'conversations.replies': { ok: true, messages: [{ ts: '1.000000', user: 'U1', text: 'x' }] },
      'users.info': { ok: true, user: { name: 'u' } },
    });
    const { items, report } = await new SlackFetcher().fetchWithReport({ token: 't', interChannelDelayMs: 0 });
    expect(items).toEqual([]);
    expect(report.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringMatching(/channels the token could not read/) }]);
  });

  it('Zoom: the recordings listing', async () => {
    serve(mockFetch, { '/users/me/recordings': R302 });
    await expect(new ZoomFetcher().fetchWithReport({ token: 't', daysBack: 1 })).rejects.toThrow(/302/);
    allManual();
  });
});
