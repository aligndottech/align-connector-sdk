/**
 * Security review of S3's fetchOne (Confluence, Notion, Slack, Teams, Zoom). Same rule as
 * S2's fetchers.fetchOne.security.test.ts: fetchOne sends a STORED credential, so a host
 * taken from the pasted URL must never receive it. Hostile forms make ZERO requests and
 * return `shape`; a valid URL still works, on the vendor's own API host, without following
 * redirects; oversized bodies are refused; failures never throw or echo the credential.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { ConfluenceFetcher } from '../fetchers/confluence.js';
import { NotionFetcher } from '../fetchers/notion.js';
import { SlackFetcher } from '../fetchers/slack.js';
import { TeamsFetcher } from '../fetchers/teams.js';
import { ZoomFetcher } from '../fetchers/zoom.js';
import { FETCH_ONE_MAX_BODY_BYTES } from '../fetchers/util/single.js';
import type { FetchOneOptions, FetchOneResult } from '../types/fetcher.js';
import { serve } from './helpers/statusFetch.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const TOKEN = 'secret-token-value-123';
const GUID = '11111111-2222-3333-4444-555555555555';
const CHANNEL = '19:abc@thread.tacv2';
const NOTION_ID = '0123456789abcdef0123456789abcdef';

function respond(status: number, body: unknown) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Awaited<ReturnType<typeof fetch>>;
}

const common = (host: string, path: string) => [
  `https://${host}@evil.com${path}`,
  `https://evil.com@${host}${path}`,
  `https://user:pw@${host}${path}`,
  `http://${host}${path}`,
  `https://${host}:8443${path}`,
  `https://${host}.evil.com${path}`,
  `https://evil.com/${host}${path}`,
  `https://${host}\\@evil.com${path}`,
  ` https://${host}${path}`,
  `https://${host}${path} `,
  `https://127.0.0.1${path}`,
  `https://169.254.169.254${path}`,
  `https://localhost${path}`,
  `https://[::1]${path}`,
  `https://evil.example${path}`,
];

const BASIC = { token: TOKEN, email: 'me@acme.io', domain: 'acme.atlassian.net' };
const OAUTH = { token: TOKEN, cloudId: 'cid', siteBase: 'https://acme.atlassian.net' };
const cfPage = { id: '123', title: 'ADR', version: { createdAt: '2026-05-11T00:00:00Z' }, body: { storage: { value: '<p>b</p>' } }, _links: { webui: '/spaces/ENG/pages/123/ADR' } };
const slackReplies = { ok: true, messages: [{ ts: '1700000000.123456', text: 'root', user: 'U1' }, { ts: '1700000001.000000', text: 'r', user: 'U1' }] };
const teamsMsg = { id: '1616963377068', lastModifiedDateTime: '2026-05-11T00:00:00Z', body: { contentType: 'text', content: 'root' }, webUrl: 'https://teams.microsoft.com/l/message/x/1616963377068' };
const TEAMS_LINK = `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL)}/1616963377068?groupId=${GUID}&teamName=P&channelName=G`;

interface Case {
  name: string;
  run: (url: string, extra?: Partial<FetchOneOptions>) => Promise<FetchOneResult>;
  valid: string;
  serveValid: () => void;
  apiHosts: RegExp;
  hostile: string[];
}

const CASES: Case[] = [
  {
    name: 'confluence basic auth',
    run: (url, extra) => new ConfluenceFetcher().fetchOne(url, { ...BASIC, ...extra }),
    valid: 'https://acme.atlassian.net/wiki/pages/123',
    serveValid: () => serve(mockFetch, { '/wiki/api/v2/pages/123': cfPage, '/rest/api/user': { displayName: 'Ada' } }),
    apiHosts: /^acme\.atlassian\.net$/,
    hostile: [...common('acme.atlassian.net', '/wiki/pages/123'), 'https://other-company.atlassian.net/wiki/pages/123'],
  },
  {
    name: 'confluence oauth',
    run: (url, extra) => new ConfluenceFetcher().fetchOne(url, { ...OAUTH, ...extra }),
    valid: 'https://acme.atlassian.net/wiki/spaces/ENG/pages/123/ADR',
    serveValid: () => serve(mockFetch, { '/wiki/api/v2/pages/123': cfPage, '/rest/api/user': { displayName: 'Ada' } }),
    apiHosts: /^api\.atlassian\.com$/,
    hostile: [...common('acme.atlassian.net', '/wiki/pages/123'), 'https://other-company.atlassian.net/wiki/pages/123'],
  },
  {
    name: 'notion',
    run: (url, extra) => new NotionFetcher().fetchOne(url, { token: TOKEN, ...extra }),
    valid: `https://www.notion.so/acme/Spec-${NOTION_ID}`,
    serveValid: () =>
      serve(mockFetch, {
        [`/v1/pages/${NOTION_ID}`]: { id: NOTION_ID, last_edited_time: '2026-05-11T00:00:00Z', properties: { title: { title: [{ plain_text: 'Spec' }] } } },
        '/v1/blocks/': { results: [] },
      }),
    apiHosts: /^api\.notion\.com$/,
    hostile: [...common('www.notion.so', `/acme/Spec-${NOTION_ID}`), `https://evil.com/Spec-${NOTION_ID}`, `https://notion.so.evil.com/${NOTION_ID}`],
  },
  {
    name: 'slack',
    run: (url, extra) => new SlackFetcher().fetchOne(url, { token: TOKEN, ...extra }),
    valid: 'https://acme.slack.com/archives/C1/p1700000000123456',
    serveValid: () =>
      serve(mockFetch, {
        'conversations.info': { ok: true, channel: { name: 'eng' } },
        'conversations.replies': slackReplies,
        'users.info': { ok: true, user: { name: 'ada' } },
      }),
    apiHosts: /^slack\.com$/,
    hostile: [...common('acme.slack.com', '/archives/C1/p1700000000123456'), 'https://slack.com.evil.com/archives/C1/p1700000000123456'],
  },
  {
    name: 'teams',
    run: (url, extra) => new TeamsFetcher().fetchOne(url, { token: TOKEN, ...extra }),
    valid: TEAMS_LINK,
    serveValid: () => serve(mockFetch, { '/messages/1616963377068/replies': { value: [] }, '/messages/1616963377068': teamsMsg }),
    apiHosts: /^graph\.microsoft\.com$/,
    hostile: [
      ...common('teams.microsoft.com', `/l/message/${encodeURIComponent(CHANNEL)}/1?groupId=${GUID}`),
      // Path injection through the ids (the reviewer read /me/messages/M1 this way).
      `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL)}/1?groupId=x/../../me/messages/M1?z=`,
      `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL)}/1?groupId=${GUID}%2F..%2F..%2Fme`,
      `https://teams.microsoft.com/l/message/${encodeURIComponent('19:a/../../me@thread.tacv2')}/1?groupId=${GUID}`,
      `https://teams.microsoft.com/l/message/${encodeURIComponent('19:a?x=1@thread.tacv2')}/1?groupId=${GUID}`,
      `https://teams.microsoft.com/l/message/${encodeURIComponent('19:..@thread.tacv2/x')}/1?groupId=${GUID}`,
      `https://teams.microsoft.com/l/message/${encodeURIComponent('../me')}/1?groupId=${GUID}`,
      `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL)}/1?groupId=not-a-guid`,
    ],
  },
];

describe.each(CASES)('$name fetchOne credential safety', ({ run, valid, serveValid, apiHosts, hostile }) => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it.each(hostile)('%j makes no request and is a shape skip', async (url) => {
    mockFetch.mockResolvedValue(respond(200, {}));
    const out = await run(url);
    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(out).toEqual({ skip: { kind: 'shape', count: 1, detail: expect.any(String) } });
  });

  it('a valid URL works, on the vendor API host only, without following redirects', async () => {
    serveValid();
    const out = await run(valid);
    expect(out.skip).toBeUndefined();
    expect(out.item).toBeDefined();
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0); // positive control for the zero-call assertions
    for (const [input, init] of mockFetch.mock.calls) {
      expect(new URL(String(input)).hostname).toMatch(apiHosts);
      expect((init as { redirect?: string }).redirect).toBe('manual');
    }
  });

  it('a redirect is not followed: an error skip without the credential', async () => {
    mockFetch.mockResolvedValue(respond(302, ''));
    const out = await run(valid);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ skip: expect.objectContaining({ kind: 'error' }) });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('an oversized body is refused as an error skip, never parsed', async () => {
    mockFetch.mockResolvedValue(respond(200, 'x'.repeat(FETCH_ONE_MAX_BODY_BYTES + 1)));
    const out = await run(valid);
    expect(out).toEqual({ skip: { kind: 'error', count: 1, detail: expect.stringContaining('too large') } });
  });

  it('a thrown network error never throws and never carries the credential', async () => {
    mockFetch.mockRejectedValue(new Error(`connect failed Authorization: Bearer ${TOKEN}`));
    const out = await run(valid);
    expect(out.skip?.kind).toBe('error');
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});

describe('Confluence fetchOne takes the credential host from options only', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('basic auth sends the credential to the configured domain, never to a URL host', async () => {
    serve(mockFetch, { '/wiki/api/v2/pages/123': cfPage, '/rest/api/user': { displayName: 'Ada' } });
    const out = await new ConfluenceFetcher().fetchOne('https://acme.atlassian.net/wiki/pages/123', BASIC);
    expect(out.item?.source_key).toBe('https://acme.atlassian.net/wiki/pages/123');
    const [input, init] = mockFetch.mock.calls[0]!;
    expect(String(input)).toBe('https://acme.atlassian.net/wiki/api/v2/pages/123?body-format=storage');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toMatch(/^Basic /);
  });

  it('basic auth with no configured domain is a shape skip and no request', async () => {
    const out = await new ConfluenceFetcher().fetchOne('https://acme.atlassian.net/wiki/pages/123', { token: TOKEN, email: 'me@acme.io' });
    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(out.skip?.kind).toBe('shape');
  });

  it('OAuth with no configured siteBase is a shape skip and no request', async () => {
    const out = await new ConfluenceFetcher().fetchOne('https://acme.atlassian.net/wiki/pages/123', { token: TOKEN, cloudId: 'cid' });
    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(out.skip?.kind).toBe('shape');
  });
});

describe('Teams fetchOne', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('builds the Graph path from the validated, encoded ids', async () => {
    serve(mockFetch, { '/messages/1616963377068/replies': { value: [] }, '/messages/1616963377068': teamsMsg });
    await new TeamsFetcher().fetchOne(TEAMS_LINK, { token: TOKEN });
    expect(String(mockFetch.mock.calls[0]![0])).toBe(
      `https://graph.microsoft.com/v1.0/teams/${GUID}/channels/${encodeURIComponent(CHANNEL)}/messages/1616963377068`,
    );
  });

  it('a 403 is an auth skip', async () => {
    serve(mockFetch, { '/messages/': { __status: 403, body: { error: { code: 'Forbidden', message: 'no' } } } });
    expect((await new TeamsFetcher().fetchOne(TEAMS_LINK, { token: TOKEN })).skip?.kind).toBe('auth');
  });

  it('replies past the page cap come back WITH a page_cap skip, and the item is marked partial', async () => {
    serve(mockFetch, {
      '/messages/1616963377068': teamsMsg,
      '/messages/1616963377068/replies': { value: [{ body: { content: 'r1' } }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next2' },
      '/v1.0/next2': { value: [{ body: { content: 'r2' } }] },
    });
    const out = await new TeamsFetcher().fetchOne(TEAMS_LINK, { token: TOKEN, maxReplyPages: 1 });
    expect(out.item?.partial).toBe(true);
    expect(out.skips).toEqual([{ kind: 'page_cap', count: 1, detail: expect.stringMatching(/replies/) }]);
  });

  it('replies inside the cap come back with no skip and not partial', async () => {
    serve(mockFetch, {
      '/messages/1616963377068': teamsMsg,
      '/messages/1616963377068/replies': { value: [{ body: { content: 'r1' } }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next2' },
      '/v1.0/next2': { value: [{ body: { content: 'r2' } }] },
    });
    const out = await new TeamsFetcher().fetchOne(TEAMS_LINK, { token: TOKEN, maxReplyPages: 2 });
    expect(out.item?.raw_text).toContain('r2');
    expect(out.item).not.toHaveProperty('partial');
    expect(out.skips).toBeUndefined();
  });
});

describe('Slack fetchOne reply cap', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('a thread past the reply-page cap comes back WITH a page_cap skip, and is marked partial', async () => {
    serve(mockFetch, {
      'conversations.info': { ok: true, channel: { name: 'eng' } },
      'conversations.replies': { ...slackReplies, response_metadata: { next_cursor: 'P2' } },
      'conversations.replies & cursor=P2': { ok: true, messages: [{ ts: '1700000002.000000', text: 'r2', user: 'U1' }] },
      'users.info': { ok: true, user: { name: 'ada' } },
    });
    const out = await new SlackFetcher().fetchOne('https://acme.slack.com/archives/C1/p1700000000123456', { token: TOKEN, maxReplyPages: 1 });
    expect(out.item?.partial).toBe(true);
    expect(out.skips).toEqual([{ kind: 'page_cap', count: 1, detail: expect.stringMatching(/replies/) }]);
  });
});

describe('fetchOne timeout bounds the author lookups too', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  /** Serve `fast` at once; anything else waits 2 s unless the request's signal aborts. */
  function slowLookups(fast: Record<string, unknown>) {
    mockFetch.mockImplementation((async (input: unknown, init?: { signal?: AbortSignal }) => {
      const url = String(input);
      const hit = Object.keys(fast).find((k) => url.includes(k));
      if (hit) return respond(200, fast[hit]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve(respond(200, { displayName: 'Late', name: 'Late' })), 2_000);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
        });
      });
    }) as never);
  }

  it('Notion: a slow user lookup is cut at timeoutMs', async () => {
    slowLookups({
      [`/v1/pages/${NOTION_ID}`]: { id: NOTION_ID, created_by: { id: 'u1' }, properties: {} },
      '/v1/blocks/': { results: [] },
    });
    const t0 = Date.now();
    const out = await new NotionFetcher().fetchOne(`https://www.notion.so/${NOTION_ID}`, { token: TOKEN, timeoutMs: 100 });
    expect(Date.now() - t0).toBeLessThan(800);
    expect(out.skip?.kind).toBe('time_budget');
  });

  it('Confluence: a slow user lookup is cut at timeoutMs', async () => {
    slowLookups({ '/wiki/api/v2/pages/123': { ...cfPage, authorId: 'acc1' } });
    const t0 = Date.now();
    const out = await new ConfluenceFetcher().fetchOne('https://acme.atlassian.net/wiki/pages/123', { ...OAUTH, timeoutMs: 100 });
    expect(Date.now() - t0).toBeLessThan(800);
    expect(out.skip?.kind).toBe('time_budget');
  });
});

describe('skip details never echo userinfo or query secrets', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const HOSTILE = 'https://bob:hunter2@acme.slack.com/nope?pwd=abc';
  it.each([
    ['confluence', () => new ConfluenceFetcher().fetchOne(HOSTILE, OAUTH)],
    ['notion', () => new NotionFetcher().fetchOne(HOSTILE, { token: TOKEN })],
    ['slack', () => new SlackFetcher().fetchOne(HOSTILE, { token: TOKEN })],
    ['teams', () => new TeamsFetcher().fetchOne(HOSTILE, { token: TOKEN })],
    ['zoom', () => new ZoomFetcher().fetchOne(HOSTILE)],
    ['zoom share link', () => new ZoomFetcher().fetchOne('https://zoom.us/rec/share/abc?pwd=abc')],
  ])('%s', async (_name, run) => {
    const out = JSON.stringify(await run());
    expect(out).toContain('shape'); // the skip exists, so the absence below is about its text
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('bob');
    expect(out).not.toContain('pwd=abc');
  });
});

describe('Slack hot threads are marked partial', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('a hot-thread item is partial, a full-thread item is not', async () => {
    const since = '2026-05-10T00:00:00.000Z';
    const s = Date.parse(since) / 1000;
    const oldRoot = (s - 40 * 86400).toFixed(6);
    const newRoot = (s + 86400).toFixed(6);
    serve(mockFetch, {
      'auth.test': { ok: true },
      'conversations.list': { ok: true, channels: [{ id: 'C1', name: 'eng' }] },
      'conversations.history': { ok: true, messages: [{ ts: newRoot, text: 'new', user: 'U1', reply_count: 2 }] },
      [`conversations.replies & ts=${newRoot}`]: { ok: true, messages: [{ ts: newRoot, text: 'new', user: 'U1' }, { ts: (s + 86401).toFixed(6), text: 'x', user: 'U1' }] },
      [`conversations.replies & ts=${oldRoot}`]: { ok: true, messages: [{ ts: (s + 10).toFixed(6), text: 'reply since', user: 'U1' }] },
      'users.info': { ok: true, user: { name: 'ada' } },
    });
    const { items } = await new SlackFetcher().fetchWithReport({ token: TOKEN, interChannelDelayMs: 0, since, hotThreads: [{ channel: 'C1', ts: oldRoot }] });
    const hot = items.find((i) => i.source_url.includes(oldRoot.replace('.', '')));
    const full = items.find((i) => i.source_url.includes(newRoot.replace('.', '')));
    expect(hot?.partial).toBe(true);
    expect(full).toBeDefined();
    expect(full).not.toHaveProperty('partial');
  });
});

describe('Confluence space lookup pages past 250 keys', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('follows the spaces cursor so a key on the second page is found, not reported missing', async () => {
    serve(mockFetch, {
      '/api/v2/spaces?keys=': { results: [{ id: '1', key: 'ENG' }], _links: { next: '/wiki/api/v2/spaces?keys=ENG,OPS&cursor=S2' } },
      '/api/v2/spaces?keys= & cursor=S2': { results: [{ id: '2', key: 'OPS' }], _links: {} },
      '/api/v2/spaces/1/pages': { results: [], _links: {} },
      '/api/v2/spaces/2/pages': { results: [], _links: {} },
    });
    const { report } = await new ConfluenceFetcher().fetchWithReport({ ...OAUTH, spaces: ['ENG', 'OPS'], limit: 100 });
    expect(report.skips).toEqual([]);
    expect(report.perScope).toEqual({ ENG: 0, OPS: 0 });
  });
});
