/**
 * S3's five fetchers read their window through S2's parseWindow: an unparseable (or
 * non-string) `since`/`until` is refused before any request (a `shape` skip, not
 * complete, nothing read), and a parseable `until` is honoured, not ignored.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { ConfluenceFetcher } from '../fetchers/confluence.js';
import { NotionFetcher } from '../fetchers/notion.js';
import { SlackFetcher } from '../fetchers/slack.js';
import { TeamsFetcher } from '../fetchers/teams.js';
import { ZoomFetcher } from '../fetchers/zoom.js';
import { DescendingWindow } from '../fetchers/util/since.js';
import type { ConnectorFetcher, ConnectorFetcherOptions } from '../types/fetcher.js';
import { serve } from './helpers/statusFetch.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const OAUTH = { token: 't', cloudId: 'cid', siteBase: 'https://acme.atlassian.net' };
const CASES: Array<[string, ConnectorFetcher, ConnectorFetcherOptions]> = [
  ['confluence', new ConfluenceFetcher(), OAUTH],
  ['confluence spaces', new ConfluenceFetcher(), { ...OAUTH, spaces: ['ENG'] }],
  ['notion', new NotionFetcher(), { token: 't' }],
  ['slack', new SlackFetcher(), { token: 't', interChannelDelayMs: 0 }],
  ['teams', new TeamsFetcher(), { token: 't' }],
  ['zoom', new ZoomFetcher(), { token: 't' }],
];

describe.each(CASES)('%s with an unparseable window', (_name, fetcher, base) => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error('no request may be made'));
  });

  it.each([
    ['since', { since: 'last tuesday' }],
    ['numeric since', { since: 1_700_000_000_000 as unknown as string }],
    ['until', { until: 'garbage' }],
    ['both', { since: '2026-03-01T00:00:00Z', until: 'garbage' }],
  ])('%s: a shape skip, not complete, nothing requested', async (_which, bound) => {
    const { items, report } = await fetcher.fetchWithReport!({ ...base, ...bound });
    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(items).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.skips).toEqual([{ kind: 'shape', count: 1, detail: expect.stringMatching(/since|until/) }]);
  });
});

describe('DescendingWindow until', () => {
  it('drops items at or after until, keeps going, and still stops before since', () => {
    const w = new DescendingWindow(Date.parse('2026-05-01T00:00:00Z'), Date.parse('2026-05-10T00:00:00Z'));
    expect(w.place('2026-05-12T00:00:00Z')).toBe('drop');
    expect(w.place('2026-05-10T00:00:00Z')).toBe('drop');
    expect(w.place('2026-05-09T00:00:00Z')).toBe('keep');
    expect(w.place('2026-04-30T00:00:00Z')).toBe('stop');
  });
});

const SINCE = '2026-05-01T00:00:00.000Z';
const UNTIL = '2026-05-10T00:00:00.000Z';
const NEW = '2026-05-12T00:00:00.000Z';
const MID = '2026-05-05T00:00:00.000Z';

describe('until is honoured', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('notion drops pages edited at or after until', async () => {
    const page = (id: string, t: string) => ({ id, url: `https://www.notion.so/${id}`, last_edited_time: t, properties: { title: { title: [{ plain_text: t }] } } });
    serve(mockFetch, {
      '/v1/search': { results: [page('a'.repeat(32), NEW), page('b'.repeat(32), MID)], has_more: false },
      '/v1/blocks/': { results: [] },
    });
    const { items } = await new NotionFetcher().fetchWithReport({ token: 't', since: SINCE, until: UNTIL, limit: 50 });
    expect(items.map((i) => i.updated_at)).toEqual([MID]);
  });

  it('confluence drops pages modified at or after until', async () => {
    const pg = (id: string, t: string) => ({ id, title: id, version: { createdAt: t }, _links: { webui: `/pages/${id}` } });
    serve(mockFetch, { '/api/v2/pages': { results: [pg('1', NEW), pg('2', MID)], _links: {} } });
    const { items } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, since: SINCE, until: UNTIL, limit: 50 });
    expect(items.map((i) => i.title)).toEqual(['2']);
  });

  it('teams drops threads last modified at or after until', async () => {
    const m = (id: string, t: string) => ({ id, lastModifiedDateTime: t, body: { content: id }, webUrl: `https://teams.microsoft.com/l/message/c/${id}` });
    serve(mockFetch, {
      '/me/joinedTeams': { value: [{ id: 'T1', displayName: 'P' }] },
      '/teams/T1/channels': { value: [{ id: 'C', displayName: 'G' }] },
      '/teams/T1/channels/C/messages': { value: [m('new', NEW), m('mid', MID)] },
    });
    const { items } = await new TeamsFetcher().fetchWithReport({ token: 't', since: SINCE, until: UNTIL, limit: 50 });
    expect(items.map((i) => i.title)).toEqual(['mid']);
  });

  it('slack passes until as latest', async () => {
    const { calls } = serve(mockFetch, {
      'auth.test': { ok: true },
      'conversations.list': { ok: true, channels: [{ id: 'C1', name: 'eng' }] },
      'conversations.history': { ok: true, messages: [] },
    });
    await new SlackFetcher().fetchWithReport({ token: 't', interChannelDelayMs: 0, since: SINCE, until: UNTIL });
    const hist = new URL(calls.find((c) => c.url.includes('conversations.history'))!.url).searchParams;
    expect(hist.get('latest')).toBe(String(Date.parse(UNTIL) / 1000));
    expect(hist.get('oldest')).toBe(String(Date.parse(SINCE) / 1000));
  });

  it('zoom windows end on the until day and drop meetings starting at or after until', async () => {
    const meeting = (uuid: string, start: string) => ({
      id: 1,
      uuid,
      topic: uuid,
      start_time: start,
      recording_files: [{ file_type: 'TRANSCRIPT', status: 'completed', download_url: `https://zoom.us/dl/${uuid}` }],
    });
    const { calls } = serve(mockFetch, {
      '/users/me/recordings': { meetings: [meeting('late', '2026-05-10T09:00:00Z'), meeting('in', MID)] },
      'https://zoom.us/dl/': 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nWe pick Postgres.\n',
    });
    const { items } = await new ZoomFetcher().fetchWithReport({ token: 't', since: SINCE, until: UNTIL, limit: 50 });
    const lists = calls.filter((c) => c.url.includes('/recordings')).map((c) => new URL(c.url).searchParams);
    expect(lists[0]!.get('to')).toBe('2026-05-10');
    expect(lists.at(-1)!.get('from')).toBe('2026-05-01');
    expect(items.map((i) => i.title)).toEqual(['in (2026-05-05)']);
  });
});
