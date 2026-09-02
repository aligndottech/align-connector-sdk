/**
 * SlackFetcher: the human-thread rule (ALI-828 phase 3), then pagination, caps
 * and the fetch report (phase 4). The two existing Slack cases stay in
 * fetchers.chat.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('drops a bot-rooted thread too, not only a tombstone-rooted one', async () => {
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
    'bot_add',
    'bot_remove',
    'reminder_add',
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
