import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { LinearFetcher } from '../fetchers/linear.js';
import { NotionFetcher } from '../fetchers/notion.js';
import { ZoomFetcher } from '../fetchers/zoom.js';
import { FetcherAuthError } from '../fetchers/errors.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body, text: async () => '' }) as unknown as Awaited<ReturnType<typeof fetch>>;
const text = (t: string) => ({ ok: true, status: 200, text: async () => t }) as unknown as Awaited<ReturnType<typeof fetch>>;

describe('LinearFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('dedups assigned+created issues (paginated per connection) and maps author = creator', async () => {
    // assignedIssues + createdIssues are fetched as separate paginated connections;
    // each call reads its own field off this response, and pageInfo stops paging.
    const noMore = { hasNextPage: false, endCursor: null };
    mockFetch.mockResolvedValue(
      ok({
        data: {
          viewer: {
            assignedIssues: {
              nodes: [
                {
                  id: 'i1',
                  title: 'Pick queue',
                  description: 'kafka vs sqs',
                  url: 'https://linear.app/i1',
                  state: { name: 'In Progress' },
                  team: { name: 'Infra' },
                  creator: { name: 'Ada', email: 'ada@x.io' },
                  comments: { nodes: [{ body: 'lean kafka', user: { name: 'Bob' } }] },
                },
              ],
              pageInfo: noMore,
            },
            createdIssues: {
              nodes: [{ id: 'i1', title: 'Pick queue', description: '', url: 'https://linear.app/i1' }],
              pageInfo: noMore,
            },
          },
        },
      }),
    );

    const items = await new LinearFetcher().fetch({ token: 'tok' });
    expect(items).toHaveLength(1); // deduped by id across both connections
    expect(items[0]).toMatchObject({ platform: 'linear', title: 'Pick queue', author: { name: 'Ada', email: 'ada@x.io' } });
    expect(items[0].raw_text).toContain('Bob: lean kafka');
  });

  it('names Linear\'s own error on a non-OK status instead of guessing the cause', async () => {
    // A 400 from Linear is a rejected REQUEST (a bad token is 401). The old message
    // said "check your personal API token" for every non-OK status, which sent a
    // user chasing a token that was fine (2026-09-03, first live Linear import).
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ errors: [{ message: 'Variable "$first" got invalid value "100"; Int cannot represent non-integer value' }] }),
      text: async () => '',
    } as unknown as Awaited<ReturnType<typeof fetch>>);
    await expect(new LinearFetcher().fetch({ token: 't' })).rejects.toThrow(/^Linear API failed \(400\): Variable "\$first" got invalid value/);
  });

  it('still points at the token when Linear says the request was not authenticated', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ errors: [{ message: 'Authentication required, not authenticated', extensions: { code: 'AUTHENTICATION_ERROR' } }] }),
      text: async () => '',
    } as unknown as Awaited<ReturnType<typeof fetch>>);
    const err = await new LinearFetcher().fetch({ token: 't' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetcherAuthError);
    expect((err as Error).message).toMatch(/Linear authentication failed \(401\): Authentication required.*token/);
  });

  it('asks for at most 20 comments per issue, so a 100-issue page stays under the complexity limit', async () => {
    // Linear scores a query by nodes requested: 100 issues x 50 comments (the default) is
    // over its 10,000-point single-query limit, and Linear reports that as a bare 400.
    const noMore = { hasNextPage: false, endCursor: null };
    mockFetch.mockResolvedValue(ok({ data: { viewer: { assignedIssues: { nodes: [], pageInfo: noMore }, createdIssues: { nodes: [], pageInfo: noMore } } } }));
    await new LinearFetcher().fetch({ token: 't', limit: 100 });
    const body = JSON.parse(String(mockFetch.mock.calls[0][1]?.body));
    expect(body.query).toContain('comments(first: 20)');
    expect(body.variables.first).toBe(100);
  });

  it('sends a personal API key bare, without the Bearer prefix Linear reserves for OAuth tokens', async () => {
    // Linear's own words on the first live local import (2026-09-03): "It looks like you're
    // trying to use an API key as a Bearer token. Remove the Bearer prefix." The CLI's local
    // mode pastes API keys, so Linear had never worked there.
    const noMore = { hasNextPage: false, endCursor: null };
    mockFetch.mockResolvedValue(ok({ data: { viewer: { assignedIssues: { nodes: [], pageInfo: noMore }, createdIssues: { nodes: [], pageInfo: noMore } } } }));
    await new LinearFetcher().fetch({ token: 'lin_api_abc123' });
    const headers = (mockFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('lin_api_abc123');
  });

  it('keeps the Bearer prefix for an OAuth access token', async () => {
    const noMore = { hasNextPage: false, endCursor: null };
    mockFetch.mockResolvedValue(ok({ data: { viewer: { assignedIssues: { nodes: [], pageInfo: noMore }, createdIssues: { nodes: [], pageInfo: noMore } } } }));
    await new LinearFetcher().fetch({ token: 'lin_oauth_xyz789' });
    const headers = (mockFetch.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer lin_oauth_xyz789');
  });

  it('surfaces GraphQL errors', async () => {
    mockFetch.mockResolvedValue(ok({ errors: [{ message: 'bad token' }], data: null }));
    await expect(new LinearFetcher().fetch({ token: 'bad' })).rejects.toThrow(/bad token/);
  });
});

describe('NotionFetcher says what Notion said on a refused request (2026-09-03 rule)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  const refused = (status: number, body: unknown) =>
    ({ ok: false, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Awaited<ReturnType<typeof fetch>>;

  it('401 is a typed FetcherAuthError carrying Notion\'s message', async () => {
    mockFetch.mockResolvedValueOnce(refused(401, { object: 'error', code: 'unauthorized', message: 'API token is invalid.' }));
    const err = await new NotionFetcher().fetch({ token: 'bad' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetcherAuthError);
    expect((err as Error).message).toMatch(/Notion authentication failed \(401\): API token is invalid\./);
  });

  it('403 names the body and says to share the pages with the integration; 500 says neither', async () => {
    mockFetch.mockResolvedValueOnce(refused(403, { object: 'error', code: 'restricted_resource', message: 'Insufficient permissions for this endpoint.' }));
    await expect(new NotionFetcher().fetch({ token: 't' })).rejects.toThrow(/^Notion API failed \(403\): Insufficient permissions for this endpoint\. .*share/i);
    mockFetch.mockResolvedValueOnce(refused(500, { object: 'error', code: 'internal_server_error', message: 'Unexpected error.' }));
    await expect(new NotionFetcher().fetch({ token: 't' })).rejects.toThrow(/^Notion API failed \(500\): Unexpected error\.$/);
  });
});

describe('ZoomFetcher says what Zoom said on a refused request (2026-09-03 rule)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  const refused = (status: number, body: unknown) =>
    ({ ok: false, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Awaited<ReturnType<typeof fetch>>;

  it('401 is a typed FetcherAuthError carrying Zoom\'s message', async () => {
    mockFetch.mockResolvedValueOnce(refused(401, { code: 124, message: 'Invalid access token.' }));
    const err = await new ZoomFetcher().fetch({ token: 'bad', daysBack: 30 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FetcherAuthError);
    expect((err as Error).message).toMatch(/Zoom authentication failed \(401\): Invalid access token\./);
  });

  it('a 429 names the status and the body and does not mention the token', async () => {
    mockFetch.mockResolvedValueOnce(refused(429, { code: 429, message: 'You have exceeded the daily rate limit.' }));
    await expect(new ZoomFetcher().fetch({ token: 't', daysBack: 30 })).rejects.toThrow(/^Zoom API failed \(429\): You have exceeded the daily rate limit\.$/);
  });
});

describe('NotionFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('maps pages with resolved creator + block text', async () => {
    mockFetch.mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/v1/search'))
        return Promise.resolve(
          ok({ results: [{ id: 'abc-123', url: 'https://notion.so/abc', created_by: { id: 'u1' }, properties: { title: { title: [{ plain_text: 'Spec' }] } } }] }),
        );
      if (url.includes('/v1/users/'))
        return Promise.resolve(ok({ name: 'Carol', person: { email: 'carol@x.io' } }));
      if (url.includes('/blocks/'))
        return Promise.resolve(ok({ results: [{ type: 'paragraph', paragraph: { rich_text: [{ plain_text: 'decide on auth' }] } }] }));
      return Promise.resolve(ok({}));
    }));

    const items = await new NotionFetcher().fetch({ token: 'tok' });
    expect(items[0]).toMatchObject({ platform: 'notion', title: 'Spec', author: { name: 'Carol', email: 'carol@x.io' } });
    expect(items[0].raw_text).toContain('decide on auth');
  });
});

describe('ZoomFetcher', () => {
  beforeEach(() => mockFetch.mockReset());

  it('parses VTT transcripts and sets author = host', async () => {
    mockFetch.mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.includes('/users/me/recordings'))
        return Promise.resolve(
          ok({
            meetings: [
              {
                id: 1,
                uuid: 'abc==',
                topic: 'Planning',
                start_time: '2026-01-15T10:00:00Z',
                host_email: 'lead@x.io',
                recording_files: [{ file_type: 'TRANSCRIPT', status: 'completed', download_url: 'https://zoom.us/dl/1' }],
              },
            ],
          }),
        );
      if (url.includes('/dl/1')) return Promise.resolve(text('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nwe will ship friday\n'));
      return Promise.resolve(ok({}));
    }));

    const items = await new ZoomFetcher().fetch({ token: 'tok' });
    expect(items[0]).toMatchObject({ platform: 'zoom', author: { name: 'lead', email: 'lead@x.io' } });
    expect(items[0].raw_text).toContain('we will ship friday');
    expect(items[0].raw_text).not.toContain('-->');
    expect(items[0].title).toContain('Planning (2026-01-15)');
  });

  it('skips meetings without a completed transcript', async () => {
    // Every dated window sees the same meeting; the uuid dedupe keeps it to one scan.
    mockFetch.mockResolvedValue(ok({ meetings: [{ id: 1, uuid: 'u', topic: 't', start_time: '2026-01-01', recording_files: [] }] }));
    const { items, report } = await new ZoomFetcher().fetchWithReport({ token: 'tok' });
    expect(items).toEqual([]);
    expect(report.scanned).toBe(1);
  });
});

describe('ZoomFetcher pagination and report (ALI-828)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const meeting = (n: number) => ({
    uuid: `m${n}==`,
    id: n,
    topic: `Meeting ${n}`,
    start_time: '2026-01-15T10:00:00Z',
    recording_files: [{ file_type: 'TRANSCRIPT', status: 'completed', download_url: `https://zoom.us/dl/${n}` }],
  });
  const meetings = (from: number, count: number) => Array.from({ length: count }, (_, i) => meeting(from + i));
  /** Serve one dated window's pages by token; any other window is empty. Zoom lists recordings
   *  per `from`/`to` window, so a fetcher that ignores the window it asked for would read the
   *  same page again under every window. */
  const serveZoom = (pages: Record<string, unknown>) => {
    const calls: string[] = [];
    let servedFrom: string | null = null;
    mockFetch.mockImplementation((async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/dl/')) return text('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nwe decided\n');
      const params = new URL(url).searchParams;
      servedFrom ??= params.get('from');
      if (params.get('from') !== servedFrom) return ok({ meetings: [], next_page_token: '' });
      return ok(pages[params.get('next_page_token') ?? '']);
    }) as never);
    return calls;
  };
  const recordingCalls = (calls: string[]) => calls.filter((u) => u.includes('/users/me/recordings'));

  it('pages with next_page_token until the requested limit is reached, keeping page_size identical', async () => {
    // R18a: limit 350 from two pages of 300 (Zoom's documented page_size max). Zoom's pagination
    // guide says every query parameter other than the token must stay identical across requests,
    // so the second request carries the token and the SAME page_size; the limit is enforced by
    // stopping, not by shrinking the page. A fresh-context review caught the first cut shrinking it.
    const calls = serveZoom({ '': { meetings: meetings(1, 300), next_page_token: 'Z2' }, Z2: { meetings: meetings(301, 300), next_page_token: '' } });
    const { items, report } = await new ZoomFetcher().fetchWithReport({ token: 'tok', limit: 350, daysBack: 30 });
    expect(items).toHaveLength(350);
    expect(new Set(items.map((i) => i.source_url)).size).toBe(350);
    const rec = recordingCalls(calls);
    expect(rec).toHaveLength(2);
    expect(rec[0]).toContain('page_size=300');
    expect(rec[0]).not.toContain('next_page_token');
    expect(rec[1]).toContain('next_page_token=Z2');
    expect(rec[1]).toContain('page_size=300');
    expect(report).toMatchObject({ platform: 'zoom', requested: 350, scanned: 350, skips: [] });
  });

  it('lists recordings in 30-day windows back to daysBack, newest first, because Zoom lists only today by default', async () => {
    // Without from/to the endpoint returns the current day, so 0.5.0's Zoom import saw almost
    // nothing and no report could have said why. Zoom allows at most a month per request.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-03-31T12:00:00Z'));
    const calls = serveZoom({ '': { meetings: [], next_page_token: '' } });
    await new ZoomFetcher().fetchWithReport({ token: 'tok', limit: 50 });
    vi.useRealTimers();
    const windows = recordingCalls(calls).map((u) => {
      const p = new URL(u).searchParams;
      return `${p.get('from')}..${p.get('to')}`;
    });
    expect(windows).toEqual(['2026-03-02..2026-03-31', '2026-01-31..2026-03-01', '2026-01-01..2026-01-30']);
  });

  it('reads the single-meeting uuid path, which returns one meeting object rather than a list', async () => {
    // /meetings/{id}/recordings answers with the meeting itself: recording_files at the top
    // level and no meetings array. Reading meetings[] there returned nothing, always, since
    // the uuid option was added. Named by a fresh-context review of ALI-828.
    mockFetch.mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.includes('/dl/')) return text('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nwe decided\n');
      return ok({
        uuid: 'abc==',
        id: 1,
        topic: 'Planning',
        start_time: '2026-01-15T10:00:00Z',
        host_email: 'lead@x.io',
        recording_files: [{ file_type: 'TRANSCRIPT', status: 'completed', download_url: 'https://zoom.us/dl/1' }],
      });
    }) as never);
    const { items, report } = await new ZoomFetcher().fetchWithReport({ token: 'tok', uuid: 'abc==' });
    expect(mockFetch.mock.calls.map((c) => String(c[0]))[0]).toBe('https://api.zoom.us/v2/meetings/abc%3D%3D/recordings');
    expect(items.map((i) => i.title)).toEqual(['Planning (2026-01-15)']);
    expect(report.scanned).toBe(1);
    expect(recordingCalls(mockFetch.mock.calls.map((c) => String(c[0])))).toHaveLength(0); // no window listing on the uuid path
  });

  it('stops opening older windows once the limit is reached', async () => {
    const calls = serveZoom({ '': { meetings: meetings(1, 5), next_page_token: '' } });
    const { items } = await new ZoomFetcher().fetchWithReport({ token: 'tok', limit: 5, daysBack: 90 });
    expect(items).toHaveLength(5);
    expect(recordingCalls(calls)).toHaveLength(1);
  });

  it('asks for exactly the limit when it is under a page, and makes one request', async () => {
    // R18b: never over-fetch a fixed 30.
    const calls = serveZoom({ '': { meetings: meetings(1, 10), next_page_token: 'Z2' } });
    const items = await new ZoomFetcher().fetch({ token: 'tok', limit: 10, daysBack: 30 });
    expect(items).toHaveLength(10);
    const rec = recordingCalls(calls);
    expect(rec).toHaveLength(1);
    expect(rec[0]).toContain('page_size=10');
  });

  it('reports meetings without a completed transcript, and transcripts it could not download', async () => {
    mockFetch.mockImplementation((async (input: unknown) => {
      const url = String(input);
      if (url.includes('/dl/ok')) return text('WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nfine\n');
      if (url.includes('/dl/broken')) return { ok: false, status: 404, text: async () => '' } as unknown as Awaited<ReturnType<typeof fetch>>;
      return ok({
        meetings: [
          { uuid: 'a', id: 1, topic: 'ok', start_time: '2026-01-01T00:00:00Z', recording_files: [{ file_type: 'TRANSCRIPT', status: 'completed', download_url: 'https://zoom.us/dl/ok' }] },
          { uuid: 'b', id: 2, topic: 'no transcript', start_time: '2026-01-01T00:00:00Z', recording_files: [{ file_type: 'MP4', status: 'completed', download_url: 'https://zoom.us/dl/mp4' }] },
          { uuid: 'c', id: 3, topic: 'broken', start_time: '2026-01-01T00:00:00Z', recording_files: [{ file_type: 'TRANSCRIPT', status: 'completed', download_url: 'https://zoom.us/dl/broken' }] },
        ],
        next_page_token: '',
      });
    }) as never);
    const { items, report } = await new ZoomFetcher().fetchWithReport({ token: 'tok', limit: 50 });
    expect(items.map((i) => i.title)).toEqual(['ok (2026-01-01)']);
    expect(report.scanned).toBe(3);
    expect(report.skips).toEqual([
      { kind: 'shape', count: 1, detail: expect.stringContaining('transcript') },
      { kind: 'error', count: 1, detail: expect.stringContaining('transcript') },
    ]);
  });
});

describe('NotionFetcher pagination and report (ALI-828)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const page = (n: number) => ({ id: `p${n}`, url: `https://notion.so/p${n}`, properties: { title: { title: [{ plain_text: `Page ${n}` }] } } });
  const pages = (from: number, count: number) => Array.from({ length: count }, (_, i) => page(from + i));
  const serveNotion = (searchPages: Record<string, unknown>, blocks: (id: string) => unknown = () => ({ results: [] })) => {
    const searches: Array<Record<string, unknown>> = [];
    mockFetch.mockImplementation((async (input: unknown, init?: { body?: string }) => {
      const url = String(input);
      if (url.endsWith('/v1/search')) {
        const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
        searches.push(body);
        return ok(searchPages[String(body.start_cursor ?? '')]);
      }
      if (url.includes('/blocks/')) {
        const id = url.split('/blocks/')[1].split('/')[0];
        const b = blocks(id);
        return b === 'throw' ? ({ ok: false, status: 500, json: async () => ({}) } as unknown as Awaited<ReturnType<typeof fetch>>) : ok(b);
      }
      return ok({});
    }) as never);
    return searches;
  };

  it('follows next_cursor while has_more, carrying start_cursor in the next request body', async () => {
    // R20a
    const searches = serveNotion({
      '': { results: pages(1, 50), has_more: true, next_cursor: 'N2' },
      N2: { results: pages(51, 50), has_more: false, next_cursor: null },
    });
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 'tok', limit: 100 });
    expect(items).toHaveLength(100);
    expect(searches).toHaveLength(2);
    expect(searches[0]).toMatchObject({ page_size: 100 });
    expect(searches[0]).not.toHaveProperty('start_cursor');
    expect(searches[1]).toMatchObject({ start_cursor: 'N2', page_size: 50 });
    expect(report).toMatchObject({ platform: 'notion', requested: 100, scanned: 100, skips: [] });
  });

  it('makes no second search when has_more is false', async () => {
    // R20b
    const searches = serveNotion({ '': { results: pages(1, 3), has_more: false, next_cursor: null } });
    const items = await new NotionFetcher().fetch({ token: 'tok', limit: 100 });
    expect(items).toHaveLength(3);
    expect(searches).toHaveLength(1);
  });

  it('reports pages whose body could not be read (kept, title only)', async () => {
    serveNotion({ '': { results: pages(1, 2), has_more: false } }, (id) => (id === 'p2' ? 'throw' : { results: [] }));
    const { items, report } = await new NotionFetcher().fetchWithReport({ token: 'tok', limit: 10 });
    expect(items).toHaveLength(2);
    expect(report.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringContaining('body') }]);
  });
});
