/**
 * S3 review round (2026-10-10): each describe pins one finding.
 * Synthetic vendor responses only; CI makes no live calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { TeamsFetcher } from '../fetchers/teams.js';
import { SlackFetcher } from '../fetchers/slack.js';
import { NotionFetcher } from '../fetchers/notion.js';
import { ZoomFetcher } from '../fetchers/zoom.js';
import { FETCH_ONE_MAX_BODY_BYTES } from '../fetchers/util/single.js';
import { buildFetchReport } from '../fetchers/util/report.js';
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

describe('2. Slack until bounds replies and hot threads; highWater never passes until', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const BASE = {
    'auth.test': { ok: true },
    'conversations.list': { ok: true, channels: [{ id: 'C1', name: 'g' }] },
    'users.info': { ok: true, user: { name: 'u' } },
  };
  const SINCE = '2023-11-14T00:00:00Z';

  it('a sub-second until rounds latest UP to the next second, so nothing before until is under-read', async () => {
    const { calls } = serve(mockFetch, { ...BASE, 'conversations.history': { ok: true, messages: [] } });
    await new SlackFetcher().fetchWithReport({ token: 't', since: SINCE, until: '2023-11-14T22:13:20.900Z', interChannelDelayMs: 0 });
    const hist = new URL(calls.find((c) => c.url.includes('conversations.history'))!.url).searchParams;
    expect(hist.get('latest')).toBe('1700000001');
  });

  it('a whole-second until is passed as is', async () => {
    const { calls } = serve(mockFetch, { ...BASE, 'conversations.history': { ok: true, messages: [] } });
    await new SlackFetcher().fetchWithReport({ token: 't', since: SINCE, until: '2023-11-14T22:13:20.000Z', interChannelDelayMs: 0 });
    expect(new URL(calls.find((c) => c.url.includes('conversations.history'))!.url).searchParams.get('latest')).toBe('1700000000');
  });

  it('drops replies at or after until, and a root inside the (rounded-up) second but after until', async () => {
    const until = '2023-11-14T22:13:20.900Z'; // 1700000000.9
    const { calls } = serve(mockFetch, {
      ...BASE,
      'conversations.history': {
        ok: true,
        messages: [
          { ts: '1699990000.000000', reply_count: 2, latest_reply: '1700100000.000000', user: 'U1', text: 'root' },
          { ts: '1700000000.950000', reply_count: 2, user: 'U1', text: 'root after until' },
        ],
      },
      'conversations.replies & ts=1699990000.000000': {
        ok: true,
        messages: [
          { ts: '1699990000.000000', user: 'U1', text: 'root' },
          { ts: '1699990001.000000', user: 'U1', text: 'inside' },
          { ts: '1700100000.000000', user: 'U1', text: 'after until' },
        ],
      },
      'conversations.replies & ts=1700000000.950000': { ok: true, messages: [{ ts: '1700000000.950000', user: 'U1', text: 'root after until' }, { ts: '1700000000.960000', user: 'U1', text: 'x' }] },
    });
    const { items, report } = await new SlackFetcher().fetchWithReport({ token: 't', since: SINCE, until, interChannelDelayMs: 0 });
    expect(items.map((i) => i.title)).toEqual(['root']);
    expect(items[0]!.raw_text).toContain('inside');
    expect(items[0]!.raw_text).not.toContain('after until');
    expect(Date.parse(report.highWater!)).toBeLessThan(Date.parse(until));
    // The root after until is not read at all (its own ts is outside the window).
    expect(calls.filter((c) => c.url.includes('ts=1700000000.950000'))).toEqual([]);
  });

  it('a hot thread drops replies at or after until, and yields nothing when only those were new', async () => {
    serve(mockFetch, {
      ...BASE,
      'conversations.list': { ok: true, channels: [] },
      'conversations.replies': { ok: true, messages: [{ ts: '1600000000.000000', user: 'U1', text: 'root' }, { ts: '1800000000.000000', user: 'U1', text: 'far after until' }] },
    });
    const { items, report } = await new SlackFetcher().fetchWithReport({
      token: 't',
      since: SINCE,
      until: '2023-11-15T00:00:00Z',
      hotThreads: [{ channel: 'C1', ts: '1600000000.000000' }],
      interChannelDelayMs: 0,
    });
    expect(items).toEqual([]);
    expect(report.highWater).toBeUndefined();
  });

  it('buildFetchReport clamps highWater to until for every connector', () => {
    const until = Date.parse('2026-05-10T00:00:00Z');
    const items = [{ source_url: 'u', platform: 'p', raw_text: 'x', updated_at: '2026-06-01T00:00:00Z' }];
    const r = buildFetchReport(items, { platform: 'p', scanned: 1, skips: [], scope: 'team', exhausted: true, untilMs: until });
    expect(r.highWater).toBe('2026-05-10T00:00:00.000Z');
    const r2 = buildFetchReport(items, { platform: 'p', scanned: 1, skips: [], scope: 'team', exhausted: true });
    expect(r2.highWater).toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('3. Notion: an unreadable or cut body is reported, and blocks are paged', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const ID = '0123456789abcdef0123456789abcdef';
  const URL_ = `https://www.notion.so/${ID}`;
  const page = { id: ID, url: URL_, last_edited_time: '2026-05-05T00:00:00Z', properties: { title: { title: [{ plain_text: 'T' }] } } };
  const block = (text: string) => ({ type: 'paragraph', paragraph: { rich_text: [{ plain_text: text }] } });

  it.each([
    ['a 500', { __status: 500, body: {} }],
    ['a 403', { __status: 403, body: {} }],
    ['an oversized body', 'x'.repeat(FETCH_ONE_MAX_BODY_BYTES + 1)],
  ])('fetchOne with %s on blocks: the item comes back partial WITH an error skip', async (_n, blocks) => {
    serve(mockFetch, { [`/v1/pages/${ID}`]: page, '/v1/blocks/': blocks });
    const out = await new NotionFetcher().fetchOne(URL_, { token: 't' });
    expect(out.item?.partial).toBe(true);
    expect(out.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringMatching(/body could not be read/) }]);
  });

  it('fetchOne pages blocks with a cursor (page_size 100) and reads every page inside the cap', async () => {
    const { calls } = serve(mockFetch, {
      [`/v1/pages/${ID}`]: page,
      '/v1/blocks/': { results: [block('one')], has_more: true, next_cursor: 'B2' },
      '/v1/blocks/ & start_cursor=B2': { results: [block('two')], has_more: false },
    });
    const out = await new NotionFetcher().fetchOne(URL_, { token: 't', maxBlockPages: 2 });
    expect(out.item?.raw_text).toContain('two');
    expect(out.item).not.toHaveProperty('partial');
    expect(out.skips).toBeUndefined();
    expect(calls.filter((c) => c.url.includes('/v1/blocks/')).every((c) => c.url.includes('page_size=100'))).toBe(true);
  });

  it('fetchOne past maxBlockPages: partial with a page_cap skip', async () => {
    serve(mockFetch, {
      [`/v1/pages/${ID}`]: page,
      '/v1/blocks/': { results: [block('one')], has_more: true, next_cursor: 'B2' },
      '/v1/blocks/ & start_cursor=B2': { results: [block('two')], has_more: false },
    });
    const out = await new NotionFetcher().fetchOne(URL_, { token: 't', maxBlockPages: 1 });
    expect(out.item?.partial).toBe(true);
    expect(out.skips).toEqual([{ kind: 'page_cap', count: 1, detail: expect.stringMatching(/blocks/) }]);
  });

  it('the list read marks cut and unreadable bodies partial and counts the cut ones as page_cap', async () => {
    const p2 = { ...page, id: 'f'.repeat(32), url: `https://www.notion.so/${'f'.repeat(32)}` };
    serve(mockFetch, {
      '/v1/search': { results: [page, p2], has_more: false },
      [`/v1/blocks/${ID}/children`]: { results: [block('one')], has_more: true, next_cursor: 'B2' },
      [`/v1/blocks/${'f'.repeat(32)}/children`]: { __status: 500, body: {} },
    });
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 't', maxBlockPages: 1 });
    expect(items.map((i) => i.partial)).toEqual([true, true]);
    expect(report.skips).toContainEqual({ kind: 'page_cap', count: 1, detail: expect.stringMatching(/blocks/) });
    expect(report.skips).toContainEqual(expect.objectContaining({ kind: 'error', count: 1 }));
  });
});

describe('4. Zoom fetchOne never echoes the share or recording token', () => {
  it.each(['https://zoom.us/rec/share/SECRETSHARETOKENabc123', 'https://acme.zoom.us/rec/play/SECRETSHARETOKENabc123?pwd=x', 'https://zoom.us/j/123?pwd=SECRETSHARETOKENabc123'])(
    '%s',
    async (url) => {
      const out = await new ZoomFetcher().fetchOne(url);
      expect(out.skip?.kind).toBe('shape');
      expect(JSON.stringify(out)).not.toContain('SECRETSHARETOKENabc123');
      expect(out.skip?.detail).toContain(new URL(url).origin); // it still says which site
    },
  );
});

