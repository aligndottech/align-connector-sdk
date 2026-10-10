/**
 * S3: `since`, cap reporting and `fetchOne` for Slack, Teams and Zoom. Synthetic vendor
 * responses only: CI makes no live calls.
 *
 * Vendor docs: Slack conversations.history `oldest` and roots' `latest_reply`
 * https://docs.slack.dev/reference/methods/conversations.history ,
 * https://docs.slack.dev/messaging/retrieving-messages , conversations.replies `oldest`
 * https://docs.slack.dev/reference/methods/conversations.replies ; Teams list channel
 * messages (`$top` <= 50, `$expand=replies`, nextLink, sorted by reply-chain last modified)
 * https://learn.microsoft.com/en-us/graph/api/channel-list-messages , get message (no
 * OData params) https://learn.microsoft.com/en-us/graph/api/chatmessage-get , list replies
 * https://learn.microsoft.com/en-us/graph/api/chatmessage-list-replies ; Zoom recordings
 * `from`/`to` at most one month https://developers.zoom.us/docs/api/meetings/#tag/cloud-recording/GET/users/{userId}/recordings
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { SlackFetcher } from '../fetchers/slack.js';
import { TeamsFetcher } from '../fetchers/teams.js';
import { ZoomFetcher } from '../fetchers/zoom.js';
import { serve } from './helpers/statusFetch.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const DAY = 86_400_000;
const SINCE = '2026-05-10T00:00:00.000Z';
const SINCE_S = Date.parse(SINCE) / 1000;
const tsAt = (offsetDays: number) => (SINCE_S + offsetDays * 86_400).toFixed(6);

const slackOk = (o: Record<string, unknown>) => ({ ok: true, ...o });
const thread = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({ ts, text, user: 'U1', reply_count: 2, ...extra });
const reps = (ts: string, text: string, n = 2) => [
  { ts, text, user: 'U1' },
  ...Array.from({ length: n }, (_, i) => ({ ts: (Number(ts) + i + 1).toFixed(6), text: `r${i}`, user: 'U1' })),
];
const SLACK_BASE = {
  'auth.test': slackOk({}),
  'conversations.list': slackOk({ channels: [{ id: 'C1', name: 'eng' }] }),
  'users.info': slackOk({ user: { name: 'ada', real_name: 'Ada L' } }),
};
const slack = (opts: Record<string, unknown> = {}) =>
  new SlackFetcher().fetchWithReport({ token: 't', interChannelDelayMs: 0, limit: 100, ...opts });

describe('SlackFetcher since', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('history oldest is since, not the daysBack default', async () => {
    const { calls } = serve(mockFetch, { ...SLACK_BASE, 'conversations.history': slackOk({ messages: [] }) });
    const since = new Date(Date.now() - 180 * DAY).toISOString();
    await slack({ since });
    const hist = calls.find((c) => c.url.includes('conversations.history'))!;
    expect(new URL(hist.url).searchParams.get('oldest')).toBe(String(Math.floor(Date.parse(since) / 1000)));
  });

  it('without since, oldest still comes from daysBack', async () => {
    const { calls } = serve(mockFetch, { ...SLACK_BASE, 'conversations.history': slackOk({ messages: [] }) });
    const before = Math.floor(Date.now() / 1000) - 30 * 86_400;
    await slack({ daysBack: 30 });
    const oldest = Number(new URL(calls.find((c) => c.url.includes('conversations.history'))!.url).searchParams.get('oldest'));
    expect(Math.abs(oldest - before)).toBeLessThanOrEqual(2);
  });

  it('one page_cap skip counts every channel whose history was cut, and names how many channels were read', async () => {
    serve(mockFetch, {
      ...SLACK_BASE,
      'conversations.list': slackOk({ channels: [1, 2, 3, 4].map((n) => ({ id: `C${n}`, name: `c${n}` })) }),
      'conversations.history': slackOk({ messages: [], response_metadata: { next_cursor: 'MORE' } }),
      'conversations.history & channel=C4': slackOk({ messages: [] }),
    });
    const { report } = await slack({ maxHistoryPages: 1 });
    const cap = report.skips.filter((s) => s.kind === 'page_cap');
    expect(cap).toEqual([{ kind: 'page_cap', count: 3, detail: expect.stringMatching(/of 4 channels read/) }]);
    expect(report.complete).toBe(false);
  });

  it('skips the replies call for a root whose latest_reply is before since, and makes it when latest_reply is after', async () => {
    const quiet = tsAt(1);
    const busy = tsAt(2);
    const { calls } = serve(mockFetch, {
      ...SLACK_BASE,
      'conversations.history': slackOk({
        messages: [thread(quiet, 'quiet', { latest_reply: tsAt(-1) }), thread(busy, 'busy', { latest_reply: tsAt(3) })],
      }),
      [`conversations.replies & ts=${busy}`]: slackOk({ messages: reps(busy, 'busy') }),
    });
    const { items } = await slack({ since: SINCE });
    const replyCalls = calls.filter((c) => c.url.includes('conversations.replies'));
    expect(replyCalls).toHaveLength(1);
    expect(replyCalls[0].url).toContain(`ts=${busy}`);
    expect(items.map((i) => i.title)).toEqual(['busy']);
  });

  it('re-reads a hot thread older than since with oldest = since, and no other old thread', async () => {
    const oldRoot = tsAt(-40);
    const { calls } = serve(mockFetch, {
      ...SLACK_BASE,
      'conversations.history': slackOk({ messages: [] }),
      [`conversations.replies & ts=${oldRoot}`]: slackOk({
        messages: [{ ts: oldRoot, text: 'old root', user: 'U1' }, { ts: tsAt(1), text: 'new reply', user: 'U1' }],
      }),
    });
    const { items } = await slack({ since: SINCE, hotThreads: [{ channel: 'C1', ts: oldRoot }] });
    const replyCalls = calls.filter((c) => c.url.includes('conversations.replies'));
    expect(replyCalls).toHaveLength(1);
    const params = new URL(replyCalls[0].url).searchParams;
    expect(params.get('channel')).toBe('C1');
    expect(params.get('ts')).toBe(oldRoot);
    expect(params.get('oldest')).toBe(String(SINCE_S));
    expect(items).toHaveLength(1);
    expect(items[0].source_url).toBe(`https://slack.com/archives/C1/p${oldRoot.replace('.', '')}`);
    expect(items[0].raw_text).toContain('new reply');
  });

  it('a hot thread with nothing at or after since yields no item', async () => {
    const oldRoot = tsAt(-40);
    serve(mockFetch, {
      ...SLACK_BASE,
      'conversations.history': slackOk({ messages: [] }),
      [`conversations.replies & ts=${oldRoot}`]: slackOk({ messages: [{ ts: oldRoot, text: 'old root', user: 'U1' }] }),
    });
    const { calls } = { calls: mockFetch.mock.calls };
    const { items } = await slack({ since: SINCE, hotThreads: [{ channel: 'C1', ts: oldRoot }] });
    expect(calls.some(([u]) => String(u).includes(`conversations.replies`))).toBe(true); // it was read
    expect(items).toEqual([]);
  });

  it('every item carries updated_at (its latest message) and source_key', async () => {
    const root = tsAt(1);
    serve(mockFetch, {
      ...SLACK_BASE,
      'conversations.history': slackOk({ messages: [thread(root, 'Pick a queue')] }),
      'conversations.replies': slackOk({ messages: reps(root, 'Pick a queue', 2) }),
    });
    const { items, report } = await slack({ since: SINCE });
    const latest = new Date((Number(root) + 2) * 1000).toISOString();
    expect(items[0]).toMatchObject({ updated_at: latest, source_key: `https://slack.com/archives/C1/p${root.replace('.', '')}` });
    expect(report.highWater).toBe(latest);
  });
});

describe('SlackFetcher.fetchOne', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('reads the thread a permalink names: root plus replies, as one item', async () => {
    const { calls } = serve(mockFetch, {
      'conversations.info': slackOk({ channel: { id: 'C1', name: 'eng' } }),
      'conversations.replies & ts=1700000000.123456': slackOk({ messages: reps('1700000000.123456', 'Use Kafka', 2) }),
      'users.info': slackOk({ user: { name: 'ada', real_name: 'Ada L' } }),
    });
    const { item, skip } = await new SlackFetcher().fetchOne('https://acme.slack.com/archives/C1/p1700000000123456', { token: 't' });
    expect(skip).toBeUndefined();
    expect(item).toMatchObject({
      platform: 'slack',
      title: 'Use Kafka',
      source_url: 'https://slack.com/archives/C1/p1700000000123456',
      source_key: 'https://slack.com/archives/C1/p1700000000123456',
    });
    expect(item!.raw_text).toContain('[#eng] Thread:');
    expect(item!.raw_text).toContain('r1');
    expect(calls.filter((c) => c.url.includes('conversations.replies'))).toHaveLength(1);
  });

  it('a reply permalink reads its thread from thread_ts', async () => {
    const { calls } = serve(mockFetch, {
      'conversations.info': slackOk({ channel: { id: 'C1', name: 'eng' } }),
      'conversations.replies & ts=1700000000.000100': slackOk({ messages: reps('1700000000.000100', 'root') }),
      'users.info': slackOk({ user: { name: 'ada', real_name: 'Ada L' } }),
    });
    const { item } = await new SlackFetcher().fetchOne(
      'https://acme.slack.com/archives/C1/p1700000005000200?thread_ts=1700000000.000100&cid=C1',
      { token: 't' },
    );
    expect(item?.source_url).toBe('https://slack.com/archives/C1/p1700000000000100');
    expect(calls.some((c) => c.url.includes('ts=1700000000.000100'))).toBe(true);
  });

  it('a channel the token cannot read is an auth skip', async () => {
    serve(mockFetch, { 'conversations.info': slackOk({ ok: false, error: 'channel_not_found' }) });
    const r = await new SlackFetcher().fetchOne('https://acme.slack.com/archives/C9/p1700000000123456', { token: 't' });
    expect(r.item).toBeUndefined();
    expect(r.skip?.kind).toBe('auth');
  });

  it('a URL that is not a message permalink is a shape skip and no request', async () => {
    const { calls } = serve(mockFetch, {});
    const r = await new SlackFetcher().fetchOne('https://acme.slack.com/archives/C1', { token: 't' });
    expect(r.skip?.kind).toBe('shape');
    expect(calls).toEqual([]);
  });
});

const CH = '19:abc@thread.tacv2';
const msg = (id: string, modified: string, text: string, replies: Array<{ text: string; modified?: string }> = []) => ({
  id,
  createdDateTime: modified,
  lastModifiedDateTime: modified,
  webUrl: `https://teams.microsoft.com/l/message/${encodeURIComponent(CH)}/${id}?groupId=T1&parentMessageId=${id}`,
  body: { contentType: 'text', content: text },
  from: { user: { displayName: 'Linus' } },
  replies: replies.map((r, i) => ({
    id: `${id}-r${i}`,
    lastModifiedDateTime: r.modified ?? modified,
    createdDateTime: r.modified ?? modified,
    body: { contentType: 'text', content: r.text },
  })),
});
const after = (n: number) => new Date(Date.parse(SINCE) + (100 - n) * 60_000).toISOString();
const TEAMS_BASE = {
  '/me/joinedTeams': { value: [{ id: 'T1', displayName: 'Platform' }] },
  '/teams/T1/channels': { value: [{ id: CH, displayName: 'General' }] },
};
const MSGS = `/teams/T1/channels/${CH}/messages`;

describe('TeamsFetcher since', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('reads 70 new messages as pages of 50, every request carrying $expand=replies, with reply text in raw_text', async () => {
    const all = Array.from({ length: 70 }, (_, i) => msg(`m${i}`, after(i), `msg ${i}`, i === 0 ? [{ text: 'the reply' }] : []));
    const { calls, unmatched } = serve(mockFetch, {
      ...TEAMS_BASE,
      // Routed ONLY with $expand=replies: a request built without it is served nothing.
      [`${MSGS}?$top=50&$expand=replies`]: { value: all.slice(0, 50), '@odata.nextLink': `https://graph.microsoft.com/v1.0${MSGS}?$top=50&$expand=replies&$skiptoken=P2` },
      [`${MSGS}?$top=50&$expand=replies & skiptoken=P2`]: { value: all.slice(50) },
    });
    const { items, report } = await new TeamsFetcher().fetchWithReport({ token: 't', since: SINCE, limit: 500 });
    expect(unmatched).toEqual([]);
    const msgCalls = calls.filter((c) => c.url.includes('/messages'));
    expect(msgCalls).toHaveLength(2);
    for (const c of msgCalls) expect(c.url).toContain('$expand=replies');
    expect(items).toHaveLength(70);
    expect(items[0].raw_text).toContain('the reply');
    expect(report.complete).toBe(true);
  });

  it('stops at the first message last modified before since and does not follow the next link', async () => {
    const { calls } = serve(mockFetch, {
      ...TEAMS_BASE,
      [`${MSGS}?$top=50&$expand=replies`]: {
        value: [msg('m1', after(1), 'new'), msg('m2', '2026-05-01T00:00:00.000Z', 'old')],
        '@odata.nextLink': `https://graph.microsoft.com/v1.0${MSGS}?$skiptoken=P2`,
      },
    });
    const { items, report } = await new TeamsFetcher().fetchWithReport({ token: 't', since: SINCE, limit: 500 });
    expect(items.map((i) => i.title)).toEqual(['new']);
    expect(calls.filter((c) => c.url.includes('skiptoken'))).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it('a reply newer than since keeps an old root: the chain time is the newest of root and replies', async () => {
    serve(mockFetch, {
      ...TEAMS_BASE,
      [`${MSGS}?$top=50&$expand=replies`]: { value: [msg('m1', '2026-04-01T00:00:00.000Z', 'old root', [{ text: 'fresh', modified: after(1) }])] },
    });
    const { items } = await new TeamsFetcher().fetchWithReport({ token: 't', since: SINCE, limit: 500 });
    expect(items).toHaveLength(1);
    expect(items[0].updated_at).toBe(after(1));
    expect(items[0].source_key).toBe(`https://teams.microsoft.com/l/message/${encodeURIComponent(CH).replace(/%[0-9a-f]{2}/g, (e) => e.toUpperCase())}/m1`);
  });

  it('an inaccessible channel is a counted error skip, and an accessible one adds none', async () => {
    serve(mockFetch, {
      ...TEAMS_BASE,
      '/teams/T1/channels': { value: [{ id: CH, displayName: 'General' }, { id: 'X', displayName: 'Private' }] },
      [`${MSGS}?$top=50&$expand=replies`]: { value: [msg('m1', after(1), 'ok')] },
      '/teams/T1/channels/X/messages': { __status: 403, body: { error: { code: 'Forbidden', message: 'no' } } },
    });
    const { items, report } = await new TeamsFetcher().fetchWithReport({ token: 't', since: SINCE, limit: 500 });
    expect(items).toHaveLength(1);
    expect(report.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringMatching(/channels the token could not read/) }]);
    expect(report.complete).toBe(false);
  });

  it('a channel refusing the token is a counted auth skip', async () => {
    serve(mockFetch, {
      ...TEAMS_BASE,
      [`${MSGS}?$top=50&$expand=replies`]: { __status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'expired' } } },
    });
    const { report } = await new TeamsFetcher().fetchWithReport({ token: 't', since: SINCE, limit: 500 });
    expect(report.skips).toEqual([{ kind: 'auth', count: 1, detail: expect.stringMatching(/refused the token/) }]);
  });

  it('the message page cap is a counted page_cap skip', async () => {
    serve(mockFetch, {
      ...TEAMS_BASE,
      [`${MSGS}?$top=50&$expand=replies`]: { value: [msg('m1', after(1), 'a')], '@odata.nextLink': `https://graph.microsoft.com/v1.0${MSGS}?$skiptoken=P2` },
    });
    const { report } = await new TeamsFetcher().fetchWithReport({ token: 't', since: SINCE, limit: 500, maxMessagePages: 1 });
    expect(report.skips).toEqual([{ kind: 'page_cap', count: 1, detail: expect.stringMatching(/cut at 1 page/) }]);
    expect(report.complete).toBe(false);
  });

  it('a thread whose replies ran past the expanded page is a counted page_cap skip', async () => {
    serve(mockFetch, {
      ...TEAMS_BASE,
      [`${MSGS}?$top=50&$expand=replies`]: { value: [{ ...msg('m1', after(1), 'a', [{ text: 'r' }]), 'replies@odata.nextLink': 'https://graph.microsoft.com/next' }] },
    });
    const { report } = await new TeamsFetcher().fetchWithReport({ token: 't', since: SINCE, limit: 500 });
    expect(report.skips).toEqual([{ kind: 'page_cap', count: 1, detail: expect.stringMatching(/replies/) }]);
  });

  it('a message with no webUrl keeps the fallback URL and gets no source_key', async () => {
    serve(mockFetch, {
      ...TEAMS_BASE,
      [`${MSGS}?$top=50&$expand=replies`]: { value: [{ ...msg('m1', after(1), 'a'), webUrl: undefined }] },
    });
    const { items } = await new TeamsFetcher().fetchWithReport({ token: 't', since: SINCE, limit: 500 });
    expect(items[0].source_url).toBe('https://teams.microsoft.com');
    expect(items[0]).not.toHaveProperty('source_key');
  });

  it('a spent time budget stops before the next channel and is a counted time_budget skip', async () => {
    serve(mockFetch, {
      ...TEAMS_BASE,
      '/teams/T1/channels': { value: [{ id: CH, displayName: 'General' }, { id: 'X', displayName: 'Two' }] },
      [`${MSGS}?$top=50&$expand=replies`]: { value: [msg('m1', after(1), 'a')] },
    });
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => (t += 10_000));
    try {
      const { report } = await new TeamsFetcher().fetchWithReport({ token: 't', limit: 500, timeBudgetMs: 5_000 });
      expect(report.skips).toContainEqual({ kind: 'time_budget', count: 1, detail: expect.stringMatching(/channels not read/) });
      expect(report.complete).toBe(false);
    } finally {
      now.mockRestore();
    }
  });
});

describe('TeamsFetcher.fetchOne', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const LINK = `https://teams.microsoft.com/l/message/${encodeURIComponent(CH)}/1616989753153?groupId=T1&tenantId=x&parentMessageId=1616963377068&teamName=Platform&channelName=General`;

  it('reads the thread root the link names (parentMessageId) with its replies', async () => {
    const { calls } = serve(mockFetch, {
      [`/teams/T1/channels/${CH}/messages/1616963377068`]: { ...msg('1616963377068', after(1), 'root text'), replies: undefined },
      [`/teams/T1/channels/${CH}/messages/1616963377068/replies`]: { value: [{ id: 'r', lastModifiedDateTime: after(0), body: { contentType: 'text', content: 'reply text' } }] },
    });
    const { item, skip } = await new TeamsFetcher().fetchOne(LINK, { token: 't' });
    expect(skip).toBeUndefined();
    expect(item!.raw_text).toContain('[Platform > #General]');
    expect(item!.raw_text).toContain('root text');
    expect(item!.raw_text).toContain('reply text');
    expect(item!.updated_at).toBe(after(0));
    expect(calls.map((c) => c.url)).toEqual([
      `https://graph.microsoft.com/v1.0/teams/T1/channels/${CH}/messages/1616963377068`,
      `https://graph.microsoft.com/v1.0/teams/T1/channels/${CH}/messages/1616963377068/replies?$top=50`,
    ]);
  });

  it('a link with no team id is a shape skip and no request', async () => {
    const { calls } = serve(mockFetch, {});
    const r = await new TeamsFetcher().fetchOne(`https://teams.microsoft.com/l/message/${encodeURIComponent(CH)}/1`, { token: 't' });
    expect(r.skip?.kind).toBe('shape');
    expect(calls).toEqual([]);
  });

  it('an expired token is an auth skip', async () => {
    serve(mockFetch, { '/messages/': { __status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'expired' } } } });
    expect((await new TeamsFetcher().fetchOne(LINK, { token: 't' })).skip?.kind).toBe('auth');
  });
});

describe('ZoomFetcher since', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const windowsFor = async (since: string) => {
    const { calls } = serve(mockFetch, { '/users/me/recordings': { meetings: [] } });
    await new ZoomFetcher().fetchWithReport({ token: 't', since, limit: 100 });
    return calls.map((c) => new URL(c.url).searchParams);
  };

  it('180 days back is 7 thirty-day windows reaching the since day', async () => {
    const since = new Date(Date.now() - 180 * DAY).toISOString();
    const ws = await windowsFor(since);
    expect(ws).toHaveLength(7);
    expect(ws.at(-1)!.get('from')).toBe(since.slice(0, 10));
  });

  it('since on the day 29 days ago is one window; 30 days ago needs a second for the since day itself', async () => {
    const day = (n: number) => new Date(Math.floor(Date.now() / DAY) * DAY - n * DAY).toISOString();
    expect(await windowsFor(day(29))).toHaveLength(1);
    mockFetch.mockReset();
    expect(await windowsFor(day(30))).toHaveLength(2);
  });

  it('drops a meeting that started before since, and sets updated_at and source_key on the rest', async () => {
    const since = new Date(Date.now() - 2 * DAY).toISOString();
    const inside = new Date(Date.now() - DAY).toISOString();
    const outside = new Date(Date.parse(since) - 60_000).toISOString();
    const meeting = (uuid: string, start: string) => ({
      id: 1,
      uuid,
      topic: `T ${uuid}`,
      start_time: start,
      recording_files: [{ file_type: 'TRANSCRIPT', status: 'completed', download_url: `https://zoom.us/dl/${uuid}` }],
    });
    serve(mockFetch, {
      '/users/me/recordings': { meetings: [meeting('in', inside), meeting('out', outside)] },
      'https://zoom.us/dl/': 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nWe pick Postgres.\n',
    });
    const { items } = await new ZoomFetcher().fetchWithReport({ token: 't', since, limit: 100 });
    expect(items.map((i) => i.title)).toEqual([`T in (${inside.slice(0, 10)})`]);
    expect(items[0]).toMatchObject({ updated_at: inside, source_key: 'https://zoom.us/recording/in' });
  });

  it('a spent time budget before the next window is a counted time_budget skip', async () => {
    serve(mockFetch, { '/users/me/recordings': { meetings: [] } });
    const now = vi.spyOn(Date, 'now');
    let t = Date.parse('2026-10-10T00:00:00Z');
    now.mockImplementation(() => (t += 10_000));
    try {
      const { report } = await new ZoomFetcher().fetchWithReport({ token: 't', daysBack: 90, limit: 100, timeBudgetMs: 5_000 });
      expect(report.skips).toContainEqual({ kind: 'time_budget', count: 2, detail: expect.stringMatching(/windows not read/) });
      expect(report.complete).toBe(false);
    } finally {
      now.mockRestore();
    }
  });

  it('fetchOne is not supported: a shape skip for every URL, and no request', async () => {
    const { calls } = serve(mockFetch, {});
    const r = await new ZoomFetcher().fetchOne('https://zoom.us/rec/share/abc', { token: 't' });
    expect(r).toEqual({ skip: { kind: 'shape', count: 1, detail: expect.stringMatching(/not supported for single capture/) } });
    expect(calls).toEqual([]);
  });
});
