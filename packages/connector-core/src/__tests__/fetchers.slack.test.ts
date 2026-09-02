/**
 * SlackFetcher: the human-thread rule (ALI-828 phase 3), then pagination, caps
 * and the fetch report (phase 4). The two existing Slack cases stay in
 * fetchers.chat.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { SlackFetcher } from '../fetchers/slack.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

interface Msg {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  reply_count?: number;
}
interface Page<T> {
  rows: T[];
  next?: string;
}
type Rows<T> = T[] | Page<T>[] | 'throw';

interface Script {
  channels?: Rows<{ id: string; name: string }>;
  history?: Record<string, Rows<Msg>>;
  replies?: Record<string, Rows<Msg>>;
  users?: Record<string, { name: string; real_name: string; email?: string }>;
  /** Called on every Slack request, before it is answered. Lets a test move a fake clock. */
  onCall?: (endpoint: string, params: URLSearchParams) => void;
}

const DEFAULT_USERS: Record<string, { name: string; real_name: string; email?: string }> = {
  U1: { name: 'ada', real_name: 'Ada L', email: 'ada@x.io' },
  U9: { name: 'grace', real_name: 'Grace H', email: 'grace@x.io' },
  USLACKBOT: { name: 'slackbot', real_name: 'Slackbot' },
};

function isPaged<T>(rows: T[] | Page<T>[]): rows is Page<T>[] {
  return rows.length > 0 && typeof rows[0] === 'object' && rows[0] !== null && 'rows' in (rows[0] as object);
}

/** Pick the page a request asked for: no cursor = page 0, cursor "P<n>" = page n. */
function pageOf<T>(rows: T[] | Page<T>[], cursor: string | null): { rows: T[]; next: string } {
  if (!isPaged(rows)) return { rows, next: '' };
  const idx = cursor ? Number(cursor.slice(1)) : 0;
  const page = rows[idx] ?? { rows: [] };
  return { rows: page.rows, next: page.next ?? (idx + 1 < rows.length ? `P${idx + 1}` : '') };
}

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Awaited<ReturnType<typeof fetch>>;

/** Serve a scripted Slack workspace. Returns the request log for assertions on what was asked. */
function serve(script: Script): Array<{ endpoint: string; params: URLSearchParams }> {
  const calls: Array<{ endpoint: string; params: URLSearchParams }> = [];
  const users = { ...DEFAULT_USERS, ...(script.users ?? {}) };
  mockFetch.mockImplementation((async (input: unknown) => {
    const url = new URL(String(input));
    const endpoint = url.pathname.replace('/api/', '');
    const params = url.searchParams;
    calls.push({ endpoint, params });
    script.onCall?.(endpoint, params);
    const cursor = params.get('cursor');

    if (endpoint === 'auth.test') return ok({ ok: true, user_id: 'U1' });
    if (endpoint === 'conversations.list') {
      const rows = script.channels ?? [{ id: 'C1', name: 'eng' }];
      if (rows === 'throw') return ok({ ok: false, error: 'invalid_auth' });
      const page = pageOf(rows, cursor);
      return ok({ ok: true, channels: page.rows, response_metadata: { next_cursor: page.next } });
    }
    if (endpoint === 'conversations.history') {
      const rows = script.history?.[params.get('channel') ?? ''] ?? [];
      if (rows === 'throw') return ok({ ok: false, error: 'channel_not_found' });
      const page = pageOf(rows, cursor);
      return ok({ ok: true, messages: page.rows, response_metadata: { next_cursor: page.next } });
    }
    if (endpoint === 'conversations.replies') {
      const rows = script.replies?.[params.get('ts') ?? ''] ?? [];
      if (rows === 'throw') return ok({ ok: false, error: 'thread_not_found' });
      const page = pageOf(rows, cursor);
      return ok({ ok: true, messages: page.rows, response_metadata: { next_cursor: page.next } });
    }
    if (endpoint === 'users.info') {
      const id = params.get('user') ?? '';
      const u = users[id];
      return ok(u ? { ok: true, user: { name: u.name, real_name: u.real_name, profile: { email: u.email } } } : { ok: false, error: 'user_not_found' });
    }
    return ok({ ok: false, error: `unscripted endpoint ${endpoint}` });
  }) as never);
  return calls;
}

const fetchAll = (opts: Record<string, unknown> = {}) => new SlackFetcher().fetch({ token: 't', interChannelDelayMs: 0, ...opts });

describe('SlackFetcher keeps a thread only when a human said something', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('drops a thread whose root is a tombstone and whose every reply is a bot (the 35-row case)', async () => {
    // R7a: a deleted root under the Align app's own replies.
    serve({
      history: { C1: [{ ts: '1.1', subtype: 'tombstone', user: 'USLACKBOT', text: 'This message was deleted.', reply_count: 2 }] },
      replies: {
        '1.1': [
          { ts: '1.1', subtype: 'tombstone', user: 'USLACKBOT', text: 'This message was deleted.' },
          { ts: '1.2', bot_id: 'B1', subtype: 'bot_message', text: 'Conversation Analysis: 1 decision created' },
          { ts: '1.3', bot_id: 'B1', user: 'U0AL', text: 'Conflict detected' },
        ],
      },
    });
    expect(await fetchAll()).toEqual([]);
  });

  it('drops a bot-rooted thread as well as a tombstone-rooted one', async () => {
    // R7b: forces the rule to be "no human message", not "the root is a tombstone".
    serve({
      history: { C1: [{ ts: '2.1', subtype: 'bot_message', bot_id: 'B1', text: 'Build failed', reply_count: 2 }] },
      replies: {
        '2.1': [
          { ts: '2.1', subtype: 'bot_message', bot_id: 'B1', text: 'Build failed' },
          { ts: '2.2', bot_id: 'B1', text: 'Build failed again' },
        ],
      },
    });
    expect(await fetchAll()).toEqual([]);
  });

  it('keeps a human-rooted thread with bot replies, bytes unchanged, bot text still in raw_text', async () => {
    // R8a / R9a: a bot reply inside a human thread is often the CI output being
    // discussed. Dropping it would move the bytes of an item the filter KEEPS.
    serve({
      history: { C1: [{ ts: '3.1', user: 'U1', text: 'Should we retry on 5xx?', reply_count: 2 }] },
      replies: {
        '3.1': [
          { ts: '3.1', user: 'U1', text: 'Should we retry on 5xx?' },
          { ts: '3.2', bot_id: 'B1', subtype: 'bot_message', text: 'Build #12 failed' },
          { ts: '3.3', bot_id: 'B1', subtype: 'bot_message', text: 'Build #13 passed' },
        ],
      },
    });
    const items = await fetchAll();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Should we retry on 5xx?');
    expect(items[0].raw_text).toBe('[#eng] Thread:\nShould we retry on 5xx?\nBuild #12 failed\nBuild #13 passed');
    expect(items[0].author?.name).toBe('Ada L');
  });

  it('keeps a tombstone-rooted thread that has a human reply, titled and attributed from that reply', async () => {
    // R8b / R9b: the human deleted their opening message and the discussion carried on.
    serve({
      history: { C1: [{ ts: '4.1', subtype: 'tombstone', user: 'USLACKBOT', text: 'This message was deleted.', reply_count: 2 }] },
      replies: {
        '4.1': [
          { ts: '4.1', subtype: 'tombstone', user: 'USLACKBOT', text: 'This message was deleted.' },
          { ts: '4.2', user: 'U9', text: 'We are going with Postgres for the ledger.' },
          { ts: '4.3', bot_id: 'B1', subtype: 'bot_message', text: 'Conversation Analysis: 1 decision created' },
        ],
      },
    });
    const items = await fetchAll();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('We are going with Postgres for the ledger.');
    expect(items[0].author?.name).toBe('Grace H'); // U9, not Slackbot
    expect(items[0].raw_text).toContain('This message was deleted.'); // the thread text is still the whole thread
  });

  it.each([
    'bot_message',
    'tombstone',
    'channel_join',
    'channel_leave',
    'channel_topic',
    'channel_purpose',
    'channel_name',
    'channel_archive',
    'channel_unarchive',
    'group_join',
    'group_leave',
    'pinned_item',
    'unpinned_item',
    'bot_add',
    'bot_remove',
    'reminder_add',
    'group_topic',
    'group_purpose',
    'group_name',
    'group_archive',
    'group_unarchive',
    'channel_convert_to_private',
    'channel_convert_to_public',
    'channel_posting_permissions',
    'ekm_access_denied',
  ])('treats subtype %s as the workspace talking, not a person', async (subtype) => {
    // Each denylist member asserted on its own: a thread made only of this
    // subtype (with a user id on it, as Slack system messages carry) is dropped.
    serve({
      history: { C1: [{ ts: '5.1', subtype, user: 'U1', text: `system ${subtype}`, reply_count: 2 }] },
      replies: {
        '5.1': [
          { ts: '5.1', subtype, user: 'U1', text: `system ${subtype}` },
          { ts: '5.2', subtype, user: 'U1', text: `system ${subtype} again` },
        ],
      },
    });
    expect(await fetchAll()).toEqual([]);
  });

  it('treats Slackbot as the workspace even when its message carries no subtype', async () => {
    // A fired /remind or a Slackbot response has user USLACKBOT, no bot_id and no subtype, so
    // the shape test alone would make it the "first human" and title the thread from it.
    serve({
      history: { C1: [{ ts: '7.1', user: 'USLACKBOT', text: 'Reminder: standup at 10.', reply_count: 2 }] },
      replies: {
        '7.1': [
          { ts: '7.1', user: 'USLACKBOT', text: 'Reminder: standup at 10.' },
          { ts: '7.2', bot_id: 'B1', text: 'ok' },
          { ts: '7.3', bot_id: 'B1', text: 'ok again' },
        ],
      },
    });
    expect(await fetchAll()).toEqual([]);
  });

  it.each(['thread_broadcast', 'file_share'])('keeps a thread whose only human message carries subtype %s', async (subtype) => {
    // A human reply also posted to the channel, and a human sharing a file
    // with a comment, are decision content and both carry a subtype.
    serve({
      history: { C1: [{ ts: '6.1', subtype: 'tombstone', user: 'USLACKBOT', text: 'This message was deleted.', reply_count: 2 }] },
      replies: {
        '6.1': [
          { ts: '6.1', subtype: 'tombstone', user: 'USLACKBOT', text: 'This message was deleted.' },
          { ts: '6.2', subtype, user: 'U9', text: 'Final call: we ship the dark theme.' },
        ],
      },
    });
    const items = await fetchAll();
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Final call: we ship the dark theme.');
  });
});

describe('SlackFetcher pagination, caps and the fetch report', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const human = (ts: string, text: string, user = 'U1', reply_count?: number): Msg =>
    ({ ts, text, user, ...(reply_count !== undefined ? { reply_count } : {}) });
  const thread = (ts: string, text: string): Msg => human(ts, text, 'U1', 2);
  const repliesFor = (ts: string, text: string): Msg[] => [human(ts, text), human(`${ts}1`, 'reply one', 'U9'), human(`${ts}2`, 'reply two')];
  const report = (opts: Record<string, unknown> = {}) =>
    new SlackFetcher().fetchWithReport({ token: 't', interChannelDelayMs: 0, ...opts });
  const channelIds = (calls: Array<{ endpoint: string; params: URLSearchParams }>) =>
    calls.filter((c) => c.endpoint === 'conversations.history').map((c) => c.params.get('channel'));

  it('scans channels from every conversations.list page', async () => {
    // R10a
    const calls = serve({
      channels: [{ rows: [{ id: 'C1', name: 'eng' }] }, { rows: [{ id: 'C2', name: 'ops' }] }],
      history: { C1: [thread('1.1', 'A')], C2: [thread('2.1', 'B')] },
      replies: { '1.1': repliesFor('1.1', 'A'), '2.1': repliesFor('2.1', 'B') },
    });
    const { items, report: r } = await report();
    expect(items.map((i) => i.title)).toEqual(['A', 'B']);
    const lists = calls.filter((c) => c.endpoint === 'conversations.list');
    expect(lists).toHaveLength(2);
    expect(lists[1].params.get('cursor')).toBe('P1');
    expect(r.skips).toEqual([]);
  });

  it('stops at maxChannels and reports how many channels it did not scan', async () => {
    // R10b, exact: the surplus is listed, and no cursor remains.
    const calls = serve({
      channels: [{ id: 'C1', name: 'a' }, { id: 'C2', name: 'b' }, { id: 'C3', name: 'c' }],
      history: { C1: [thread('1.1', 'A')], C2: [thread('2.1', 'B')], C3: [thread('3.1', 'C')] },
      replies: { '1.1': repliesFor('1.1', 'A'), '2.1': repliesFor('2.1', 'B'), '3.1': repliesFor('3.1', 'C') },
    });
    const { items, report: r } = await report({ maxChannels: 2 });
    expect(items.map((i) => i.title)).toEqual(['A', 'B']);
    expect(channelIds(calls)).toEqual(['C1', 'C2']);
    expect(r.skips).toEqual([{ kind: 'page_cap', count: 1, detail: expect.stringContaining('channels not scanned') }]);
  });

  it('says "or more" when the channel cap fired with list pages still unread', async () => {
    // R10b, second example: the count it can name is a floor, and the detail says so.
    const calls = serve({
      channels: [
        { rows: [{ id: 'C1', name: 'a' }, { id: 'C2', name: 'b' }, { id: 'C3', name: 'c' }] },
        { rows: [{ id: 'C4', name: 'd' }] },
      ],
      history: { C1: [thread('1.1', 'A')], C2: [thread('2.1', 'B')] },
      replies: { '1.1': repliesFor('1.1', 'A'), '2.1': repliesFor('2.1', 'B') },
    });
    const { report: r } = await report({ maxChannels: 2 });
    expect(channelIds(calls)).toEqual(['C1', 'C2']);
    expect(calls.filter((c) => c.endpoint === 'conversations.list')).toHaveLength(1); // did not read page 2 to count it
    expect(r.skips).toEqual([{ kind: 'page_cap', count: 1, detail: expect.stringMatching(/^or more channels not scanned/) }]);
  });

  it('reads the next list page when the first holds exactly the cap, and names the surplus exactly', async () => {
    // The boundary: a page holding exactly maxChannels channels with a cursor behind it. The
    // fetcher must read on (a `>=` here would stop, see nothing past the cap, and emit no
    // skip while unscanned channels exist). A fresh-context mutant run found that untested.
    const calls = serve({
      channels: [{ rows: [{ id: 'C1', name: 'a' }, { id: 'C2', name: 'b' }] }, { rows: [{ id: 'C3', name: 'c' }] }],
      history: { C1: [thread('1.1', 'A')], C2: [thread('2.1', 'B')] },
      replies: { '1.1': repliesFor('1.1', 'A'), '2.1': repliesFor('2.1', 'B') },
    });
    const { items, report: r } = await report({ maxChannels: 2 });
    expect(calls.filter((c) => c.endpoint === 'conversations.list')).toHaveLength(2);
    expect(items.map((i) => i.title)).toEqual(['A', 'B']);
    expect(r.skips).toEqual([{ kind: 'page_cap', count: 1, detail: expect.stringMatching(/^channels not scanned/) }]);
  });

  it('emits no channel skip when the workspace holds exactly the cap', async () => {
    serve({
      channels: [{ rows: [{ id: 'C1', name: 'a' }, { id: 'C2', name: 'b' }] }, { rows: [] }],
      history: { C1: [thread('1.1', 'A')], C2: [thread('2.1', 'B')] },
      replies: { '1.1': repliesFor('1.1', 'A'), '2.1': repliesFor('2.1', 'B') },
    });
    const { items, report: r } = await report({ maxChannels: 2 });
    expect(items.map((i) => i.title)).toEqual(['A', 'B']);
    expect(r.skips).toEqual([]);
  });

  it('turns threads from every history page into items', async () => {
    // R11a
    const calls = serve({
      history: { C1: [{ rows: [thread('1.1', 'A')] }, { rows: [thread('1.2', 'B')] }] },
      replies: { '1.1': repliesFor('1.1', 'A'), '1.2': repliesFor('1.2', 'B') },
    });
    const { items, report: r } = await report();
    expect(items.map((i) => i.title)).toEqual(['A', 'B']);
    const hist = calls.filter((c) => c.endpoint === 'conversations.history');
    expect(hist).toHaveLength(2);
    expect(hist[1].params.get('cursor')).toBe('P1');
    expect(r.skips).toEqual([]);
  });

  it('stops history paging at maxHistoryPages and reports the channel it cut', async () => {
    // R11b
    const calls = serve({
      history: { C1: [{ rows: [thread('1.1', 'A')] }, { rows: [thread('1.2', 'B')] }] },
      replies: { '1.1': repliesFor('1.1', 'A'), '1.2': repliesFor('1.2', 'B') },
    });
    const { items, report: r } = await report({ maxHistoryPages: 1 });
    expect(items.map((i) => i.title)).toEqual(['A']);
    expect(calls.filter((c) => c.endpoint === 'conversations.history')).toHaveLength(1);
    expect(r.skips).toEqual([{ kind: 'page_cap', count: 1, detail: expect.stringContaining('history') }]);
  });

  it('joins replies from every reply page into raw_text', async () => {
    // R12a
    const calls = serve({
      history: { C1: [thread('1.1', 'A')] },
      replies: { '1.1': [{ rows: [human('1.1', 'A'), human('1.2', 'first page reply', 'U9')] }, { rows: [human('1.3', 'second page reply', 'U9')] }] },
    });
    const { items } = await report();
    expect(items).toHaveLength(1);
    expect(items[0].raw_text).toContain('first page reply');
    expect(items[0].raw_text).toContain('second page reply');
    const rep = calls.filter((c) => c.endpoint === 'conversations.replies');
    expect(rep).toHaveLength(2);
    expect(rep[1].params.get('cursor')).toBe('P1');
  });

  it('asks each endpoint for its documented maximum page, so the page caps bound generously', async () => {
    // 0.5.0 sent conversations.replies with no limit, and Slack's default there is 1000 (also
    // the max). Paging at 100 would have cut a 301-message thread at maxReplyPages, moving the
    // bytes of a KEPT item, which the golden contract forbids. list and history must be under
    // 1000. A fresh-context review caught the regression.
    const calls = serve({
      history: { C1: [thread('1.1', 'A')] },
      replies: { '1.1': repliesFor('1.1', 'A') },
    });
    await report();
    const limitOf = (endpoint: string) => calls.filter((c) => c.endpoint === endpoint).map((c) => c.params.get('limit'));
    expect(limitOf('conversations.list')).toEqual(['999']);
    expect(limitOf('conversations.history')).toEqual(['999']);
    expect(limitOf('conversations.replies')).toEqual(['1000']);
  });

  it('does not repeat the root when a later reply page carries the parent again', async () => {
    // Slack does not document whether cursor pages of conversations.replies repeat the parent
    // message. Dedupe by ts costs nothing and makes the question moot.
    serve({
      history: { C1: [thread('1.1', 'A')] },
      replies: {
        '1.1': [
          { rows: [human('1.1', 'A'), human('1.2', 'first page reply', 'U9')] },
          { rows: [human('1.1', 'A'), human('1.3', 'second page reply', 'U9')] },
        ],
      },
    });
    const { items } = await report();
    expect(items[0].raw_text).toBe('[#eng] Thread:\nA\nfirst page reply\nsecond page reply');
  });

  it('keeps a thread cut at maxReplyPages as an item and reports the truncation', async () => {
    // R12b: a truncated thread is not a dropped thread.
    serve({
      history: { C1: [thread('1.1', 'A')] },
      replies: { '1.1': [{ rows: [human('1.1', 'A'), human('1.2', 'first page reply', 'U9')] }, { rows: [human('1.3', 'second page reply', 'U9')] }] },
    });
    const { items, report: r } = await report({ maxReplyPages: 1 });
    expect(items).toHaveLength(1);
    expect(items[0].raw_text).toContain('first page reply');
    expect(items[0].raw_text).not.toContain('second page reply');
    expect(r.skips).toEqual([{ kind: 'page_cap', count: 1, detail: expect.stringContaining('repl') }]);
  });

  it('reports messages with fewer than 2 replies as not imported, by count', async () => {
    // R13a
    serve({
      history: {
        C1: [human('1.1', 'a'), human('1.2', 'b', 'U1', 0), human('1.3', 'c', 'U1', 1), human('1.4', 'd', 'U9', 1), human('1.5', 'e')],
      },
    });
    const { items, report: r } = await report();
    expect(items).toEqual([]);
    expect(r.skips).toEqual([{ kind: 'shape', count: 5, detail: expect.stringContaining('fewer than 2 replies') }]);
  });

  it('reports threads with no human message as not imported, by count', async () => {
    // The phase-3 drop, now visible: Open Question 1 in the plan says the demo
    // seed's bot-posted threads must read as "N threads with no human message".
    serve({
      history: { C1: [{ ts: '1.1', subtype: 'tombstone', user: 'USLACKBOT', text: 'This message was deleted.', reply_count: 2 }, thread('2.1', 'A')] },
      replies: {
        '1.1': [{ ts: '1.1', subtype: 'tombstone', user: 'USLACKBOT', text: 'This message was deleted.' }, { ts: '1.2', bot_id: 'B1', text: 'bot' }],
        '2.1': repliesFor('2.1', 'A'),
      },
    });
    const { items, report: r } = await report();
    expect(items.map((i) => i.title)).toEqual(['A']);
    expect(r.scanned).toBe(2);
    expect(r.skips).toEqual([{ kind: 'shape', count: 1, detail: expect.stringContaining('no human message') }]);
  });

  it('keeps going when one channel cannot be read, and reports it', async () => {
    // R14a
    serve({
      channels: [{ id: 'C1', name: 'a' }, { id: 'C2', name: 'b' }, { id: 'C3', name: 'c' }],
      history: { C1: [thread('1.1', 'A')], C2: 'throw', C3: [thread('3.1', 'C')] },
      replies: { '1.1': repliesFor('1.1', 'A'), '3.1': repliesFor('3.1', 'C') },
    });
    const { items, report: r } = await report();
    expect(items.map((i) => i.title)).toEqual(['A', 'C']);
    expect(r.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringContaining('channels') }]);
  });

  it('keeps going when one thread cannot be read, and reports it', async () => {
    // R14b
    serve({
      history: { C1: [thread('1.1', 'A'), thread('1.2', 'B')] },
      replies: { '1.1': 'throw', '1.2': repliesFor('1.2', 'B') },
    });
    const { items, report: r } = await report();
    expect(items.map((i) => i.title)).toEqual(['B']);
    expect(r.scanned).toBe(2);
    expect(r.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringContaining('threads') }]);
  });

  const tenChannels = Array.from({ length: 10 }, (_, i) => ({ id: `C${i + 1}`, name: `c${i + 1}` }));
  const tenHistories = Object.fromEntries(tenChannels.map((c, i) => [c.id, [thread(`${i + 1}.1`, `T${i + 1}`)]]));
  const tenReplies = Object.fromEntries(tenChannels.map((c, i) => [`${i + 1}.1`, repliesFor(`${i + 1}.1`, `T${i + 1}`)]));

  it('stops requesting channels once the time budget is spent, and says so', async () => {
    // R15a: each channel read costs one fake minute; the budget is spent before channel 4 of 10.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const calls = serve({
      channels: tenChannels,
      history: tenHistories,
      replies: tenReplies,
      onCall: (endpoint) => {
        if (endpoint === 'conversations.history') vi.setSystemTime(Date.now() + 60_000);
      },
    });
    const { items, report: r } = await report({ timeBudgetMs: 2.5 * 60_000 });
    expect(channelIds(calls)).toEqual(['C1', 'C2', 'C3']);
    expect(items.map((i) => i.title)).toEqual(['T1', 'T2', 'T3']);
    expect(r.skips).toEqual([{ kind: 'time_budget', count: 7, detail: expect.stringContaining('time budget') }]);
  });

  it('spends the whole budget: a channel starting exactly at the deadline is still read', async () => {
    // Pins the operator (`>` rather than `>=`): with a 3-minute budget and one minute per channel,
    // the check before channel 4 sees exactly 3 minutes and reads it; channel 5 sees 4 and stops.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const calls = serve({
      channels: tenChannels,
      history: tenHistories,
      replies: tenReplies,
      onCall: (endpoint) => {
        if (endpoint === 'conversations.history') vi.setSystemTime(Date.now() + 60_000);
      },
    });
    const { report: r } = await report({ timeBudgetMs: 3 * 60_000 });
    expect(channelIds(calls)).toEqual(['C1', 'C2', 'C3', 'C4']);
    expect(r.skips).toEqual([{ kind: 'time_budget', count: 6, detail: expect.stringContaining('time budget') }]);
  });

  it('checks the budget BEFORE paying the inter-channel delay', async () => {
    // Placement: once the budget is spent no delay is paid, so setTimeout is called once per
    // channel actually read after the first (2 for 3 channels), never for the channel it refuses.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const sleeps = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as never);
    serve({
      channels: tenChannels,
      history: tenHistories,
      replies: tenReplies,
      onCall: (endpoint) => {
        if (endpoint === 'conversations.history') vi.setSystemTime(Date.now() + 60_000);
      },
    });
    const { items } = await report({ timeBudgetMs: 2.5 * 60_000, interChannelDelayMs: 1000 });
    expect(items).toHaveLength(3);
    expect(sleeps).toHaveBeenCalledTimes(2);
    sleeps.mockRestore();
  });

  it('scans every channel when the time budget is never spent', async () => {
    // R15b
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(0);
    const calls = serve({
      channels: tenChannels,
      history: tenHistories,
      replies: tenReplies,
      onCall: (endpoint) => {
        if (endpoint === 'conversations.history') vi.setSystemTime(Date.now() + 60_000);
      },
    });
    const { items, report: r } = await report({ timeBudgetMs: 60 * 60_000 });
    expect(channelIds(calls)).toHaveLength(10);
    expect(items).toHaveLength(10);
    expect(r.skips).toEqual([]);
  });

  it('reports requested and scanned when the source holds fewer than asked', async () => {
    // R21a
    const threads = Array.from({ length: 30 }, (_, i) => thread(`${i + 1}.1`, `T${i + 1}`));
    serve({
      history: { C1: threads },
      replies: Object.fromEntries(threads.map((t) => [t.ts, repliesFor(t.ts, t.text ?? '')])),
    });
    const { items, report: r } = await report({ limit: 50 });
    expect(items).toHaveLength(30);
    expect(r).toMatchObject({ platform: 'slack', requested: 50, scanned: 30 });
  });

  it('reports requested and scanned when the source holds more than asked', async () => {
    // R21b
    const threads = Array.from({ length: 80 }, (_, i) => thread(`${i + 1}.1`, `T${i + 1}`));
    serve({
      history: { C1: threads },
      replies: Object.fromEntries(threads.map((t) => [t.ts, repliesFor(t.ts, t.text ?? '')])),
    });
    const { items, report: r } = await report({ limit: 50 });
    expect(items).toHaveLength(50);
    expect(r).toMatchObject({ platform: 'slack', requested: 50, scanned: 50 });
  });
});
