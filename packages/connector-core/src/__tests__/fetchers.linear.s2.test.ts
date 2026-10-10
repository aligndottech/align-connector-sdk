/**
 * S2 Linear: team scope on named teams via the top-level `issues` filter, `since`/`until`
 * as `updatedAt` comparators (https://linear.app/developers/filtering), the request budget
 * read from `X-RateLimit-Requests-Remaining` (https://linear.app/developers/rate-limiting),
 * page errors as skips, the time budget, and fetchOne. Synthetic responses; no live call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { LinearFetcher, linearRequestsPerHour } from '../fetchers/linear.js';
import { fakeClockForTests } from '../fetchers/util/pace.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const res = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Awaited<ReturnType<typeof fetch>>;

const node = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Issue ${id}`,
  description: null,
  url: `https://linear.app/acme/issue/ENG-${id}/issue-slug`,
  createdAt: '2026-03-01T00:00:00.000Z',
  updatedAt: '2026-03-06T00:00:00.000Z',
  state: { name: 'Todo' },
  team: { name: 'Infra' },
  creator: { name: 'Ada' },
  comments: { nodes: [] },
  ...over,
});

interface Call {
  query: string;
  variables: Record<string, unknown>;
  auth: string;
}

function serve(route: (c: Call) => { status?: number; body?: unknown; headers?: Record<string, string> }): Call[] {
  const calls: Call[] = [];
  mockFetch.mockImplementation(async (input: unknown, init?: { body?: unknown; headers?: Record<string, string> }) => {
    if (input === undefined) return res({});
    const parsed = JSON.parse(String(init?.body ?? '{}')) as { query: string; variables: Record<string, unknown> };
    const call = { query: parsed.query, variables: parsed.variables ?? {}, auth: init?.headers?.Authorization ?? '' };
    calls.push(call);
    const out = route(call);
    return res(out.body ?? {}, out.status ?? 200, out.headers ?? {});
  });
  return calls;
}

const page = (field: string, nodes: unknown[], hasNextPage = false, viewer = true) => {
  const conn = { nodes, pageInfo: { hasNextPage, endCursor: hasNextPage ? 'c' : null } };
  return { data: viewer ? { viewer: { [field]: conn } } : { [field]: conn } };
};

describe('Linear team scope and since', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('teams + since: top-level issues filtered by team and updatedAt, scope team', async () => {
    const calls = serve(() => ({ body: page('issues', [node('1')], false, false) }));
    const { items, report } = await new LinearFetcher().fetchWithReport({ token: 'lin_api_x', teams: ['team-uuid'], since: '2026-03-01T00:00:00Z' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toMatch(/issues\(first: \$first, after: \$after, orderBy: updatedAt, filter: \$filter\)/);
    expect(calls[0]!.query).not.toContain('viewer');
    expect(calls[0]!.variables.filter).toEqual({ team: { id: { in: ['team-uuid'] } }, updatedAt: { gte: '2026-03-01T00:00:00.000Z' } });
    expect(report.scope).toBe('team');
    expect(items).toHaveLength(1);
  });

  it('no teams: the viewer connections with the same updatedAt filter, scope yours', async () => {
    const calls = serve((c) => ({ body: page(c.query.includes('assignedIssues') ? 'assignedIssues' : 'createdIssues', []) }));
    const { report } = await new LinearFetcher().fetchWithReport({ token: 'lin_api_x', since: '2026-03-01T00:00:00Z', until: '2026-04-01T00:00:00Z' });
    expect(calls.map((c) => /viewer \{ (\w+)/.exec(c.query)?.[1]).sort()).toEqual(['assignedIssues', 'createdIssues']);
    for (const c of calls) expect(c.variables.filter).toEqual({ updatedAt: { gte: '2026-03-01T00:00:00.000Z', lt: '2026-04-01T00:00:00.000Z' } });
    expect(report.scope).toBe('yours');
  });

  it('no since: no filter at all, as before', async () => {
    const calls = serve((c) => ({ body: page(c.query.includes('assignedIssues') ? 'assignedIssues' : 'createdIssues', []) }));
    await new LinearFetcher().fetch({ token: 'lin_api_x' });
    for (const c of calls) expect(c.variables.filter).toBeUndefined();
  });

  it('every item carries updatedAt as updated_at and a slug-free source_key', async () => {
    serve(() => ({ body: page('issues', [node('7')], false, false) }));
    const { items, report } = await new LinearFetcher().fetchWithReport({ token: 'lin_api_x', teams: ['t'] });
    expect(items[0]).toMatchObject({ updated_at: '2026-03-06T00:00:00.000Z', source_key: 'https://linear.app/acme/issue/ENG-7' });
    expect(report.highWater).toBe('2026-03-06T00:00:00.000Z');
  });

  it('stops before running into the vendor limit: a low X-RateLimit-Requests-Remaining is a vendor_cap skip', async () => {
    serve(() => ({ body: page('issues', [node('1')], true, false), headers: { 'x-ratelimit-requests-remaining': '3' } }));
    const { items, report } = await new LinearFetcher().fetchWithReport({ token: 'lin_api_x', teams: ['t'], limit: 1000 });
    expect(items).toHaveLength(1);
    expect(report.skips).toEqual([{ kind: 'vendor_cap', count: 1, detail: expect.stringContaining('3 requests') }]);
    expect(report.complete).toBe(false);
  });

  it('a healthy remaining count is no skip', async () => {
    serve(() => ({ body: page('issues', [node('1')], false, false), headers: { 'x-ratelimit-requests-remaining': '2400' } }));
    const { report } = await new LinearFetcher().fetchWithReport({ token: 'lin_api_x', teams: ['t'] });
    expect(report.skips).toEqual([]);
    expect(report.complete).toBe(true);
  });

  it('paces to 2,500 requests an hour for an API key and 5,000 for OAuth', () => {
    expect(linearRequestsPerHour('lin_api_abc')).toBe(2_500);
    expect(linearRequestsPerHour('lin_oauth_abc')).toBe(5_000);
  });

  it('a failed later page is an error skip keeping what was read; a failed first page still throws', async () => {
    serve((c) => (c.variables.after ? { status: 500, body: {} } : { body: page('issues', [node('1')], true, false) }));
    const { items, report } = await new LinearFetcher().fetchWithReport({ token: 'lin_api_x', teams: ['t'], limit: 1000 });
    expect(items).toHaveLength(1);
    expect(report.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringContaining('500') }]);

    serve(() => ({ status: 500, body: {} }));
    await expect(new LinearFetcher().fetch({ token: 'lin_api_x', teams: ['t'] })).rejects.toThrow(/Linear API failed \(500\)/);
  });

  it('stops at timeBudgetMs with a time_budget skip', async () => {
    const clock = fakeClockForTests();
    serve(() => {
      clock.advance(5_000);
      return { body: page('issues', [node(String(Math.random()))], true, false) };
    });
    const { report } = await new LinearFetcher().fetchWithReport({ token: 'lin_api_x', teams: ['t'], limit: 1000, timeBudgetMs: 4_000, clock });
    expect(report.skips).toEqual([{ kind: 'time_budget', count: 1, detail: expect.stringContaining('4000 ms') }]);
  });
});

describe('Linear fetchOne', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('an issue URL is one issue(id) request by identifier, mapped like an imported item', async () => {
    const calls = serve(() => ({ body: { data: { issue: node('12', { url: 'https://linear.app/acme/issue/ENG-12/issue-slug' }) } } }));
    const { item, skip } = await new LinearFetcher().fetchOne('https://linear.app/acme/issue/ENG-12/renamed-slug#comment-1', { token: 'lin_api_x' });
    expect(skip).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.query).toMatch(/issue\(id: \$id\)/);
    expect(calls[0]!.variables).toEqual({ id: 'ENG-12' });
    expect(calls[0]!.auth).toBe('lin_api_x');
    expect(item).toEqual({
      source_url: 'https://linear.app/acme/issue/ENG-12/issue-slug',
      platform: 'linear',
      raw_text: 'Issue 12\n\nTeam: Infra\n\nStatus: Todo',
      title: 'Issue 12',
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-06T00:00:00.000Z',
      source_key: 'https://linear.app/acme/issue/ENG-12',
      author: { name: 'Ada' },
    });
  });

  it('401 is an auth skip; an unknown issue is an error skip', async () => {
    serve(() => ({ status: 401, body: {} }));
    expect((await new LinearFetcher().fetchOne('https://linear.app/acme/issue/ENG-12', { token: 'x' })).skip).toMatchObject({ kind: 'auth' });
    serve(() => ({ body: { data: { issue: null }, errors: [{ message: 'Entity not found: Issue' }] } }));
    expect((await new LinearFetcher().fetchOne('https://linear.app/acme/issue/ENG-12', { token: 'x' })).skip).toMatchObject({
      kind: 'error',
      detail: expect.stringContaining('Entity not found'),
    });
  });

  it.each(['https://linear.app/acme/issue/eng12', 'https://linear.app/acme/project/p-1', 'https://evil.example/acme/issue/ENG-1', 'nope'])(
    '%s is a shape skip with no request',
    async (url) => {
      const calls = serve(() => ({ body: {} }));
      expect(await new LinearFetcher().fetchOne(url, { token: 'x' })).toEqual({ skip: { kind: 'shape', count: 1, detail: expect.any(String) } });
      expect(calls).toEqual([]);
    },
  );
});
