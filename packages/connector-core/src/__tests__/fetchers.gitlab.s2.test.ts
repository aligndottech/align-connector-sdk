/**
 * S2 GitLab: team scope on a named project, `since`/`until` via the vendor's own
 * `updated_after`/`updated_before` (https://docs.gitlab.com/api/merge_requests/), the
 * time budget, and fetchOne. Synthetic responses shaped to that API; no live call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { GitLabFetcher } from '../fetchers/gitlab.js';
import { fakeClockForTests } from '../fetchers/util/pace.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const res = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Awaited<
    ReturnType<typeof fetch>
  >;

const mr = (iid: number, over: Record<string, unknown> = {}) => ({
  iid,
  title: `MR ${iid}`,
  description: 'why',
  state: 'merged',
  created_at: '2026-03-01T00:00:00.000Z',
  updated_at: '2026-03-05T00:00:00.000Z',
  web_url: `https://gitlab.com/g/p/-/merge_requests/${iid}`,
  ...over,
});

function serve(route: (url: string) => { status?: number; body?: unknown }): string[] {
  const urls: string[] = [];
  mockFetch.mockImplementation(async (input: unknown) => {
    if (input === undefined) return res({});
    const url = String(input);
    urls.push(url);
    const out = route(url);
    return res(out.body ?? [], out.status ?? 200);
  });
  return urls;
}

describe('GitLab team scope and since', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('projectId + since reads the project MRs by updated_after, newest first, all states', async () => {
    const urls = serve((u) => ({ body: u.includes('/user') ? { id: 42 } : [mr(3)] }));
    const { items, report } = await new GitLabFetcher().fetchWithReport({ token: 't', projectId: 'g/p', since: '2026-03-01T00:00:00Z' });
    const list = urls.find((u) => u.includes('/merge_requests'))!;
    expect(list.startsWith('https://gitlab.com/api/v4/projects/g%2Fp/merge_requests?')).toBe(true);
    const q = new URL(list).searchParams;
    expect(q.get('updated_after')).toBe('2026-03-01T00:00:00.000Z');
    expect(q.get('order_by')).toBe('updated_at');
    expect(q.get('sort')).toBe('desc');
    expect(q.get('state')).toBe('all');
    expect(q.has('author_id')).toBe(false);
    expect(q.has('updated_before')).toBe(false);
    expect(report.scope).toBe('team');
    expect(items).toHaveLength(1);
  });

  it('until is updated_before', async () => {
    const urls = serve((u) => ({ body: u.includes('/user') ? { id: 42 } : [] }));
    await new GitLabFetcher().fetch({ token: 't', projectId: 7, since: '2026-03-01T00:00:00Z', until: '2026-04-01T00:00:00Z' });
    const q = new URL(urls.find((u) => u.includes('/merge_requests'))!).searchParams;
    expect(q.get('updated_before')).toBe('2026-04-01T00:00:00.000Z');
  });

  it('no projectId stays author-scoped (the caller), scope yours, and since adds updated_after', async () => {
    const urls = serve((u) => ({ body: u.includes('/user') ? { id: 42 } : [mr(3)] }));
    const { report } = await new GitLabFetcher().fetchWithReport({ token: 't', since: '2026-03-01T00:00:00Z' });
    const q = new URL(urls.find((u) => u.includes('/merge_requests'))!).searchParams;
    expect(urls.find((u) => u.includes('/merge_requests'))!.startsWith('https://gitlab.com/api/v4/merge_requests?')).toBe(true);
    expect(q.get('author_id')).toBe('42');
    expect(q.get('updated_after')).toBe('2026-03-01T00:00:00.000Z');
    expect(report.scope).toBe('yours');
  });

  it('every item carries the vendor updated_at and its source_key', async () => {
    serve((u) => ({ body: u.includes('/user') ? { id: 42 } : [mr(3)] }));
    const { items, report } = await new GitLabFetcher().fetchWithReport({ token: 't', projectId: 'g/p' });
    expect(items[0]).toMatchObject({ updated_at: '2026-03-05T00:00:00.000Z', source_key: 'https://gitlab.com/g/p/-/merge_requests/3' });
    expect(report.highWater).toBe('2026-03-05T00:00:00.000Z');
  });

  it('stops at timeBudgetMs with a time_budget skip, and has none without pressure', async () => {
    const clock = fakeClockForTests();
    serve((u) => {
      clock.advance(3_000); // the first page alone spends the budget
      return { body: u.includes('/user') ? { id: 42 } : Array.from({ length: 100 }, (_, i) => mr(i)) };
    });
    const { items, report } = await new GitLabFetcher().fetchWithReport({ token: 't', projectId: 'g/p', limit: 1000, timeBudgetMs: 3_000, clock });
    expect(items.length).toBe(100);
    expect(report.skips).toEqual([{ kind: 'time_budget', count: 1, detail: expect.stringContaining('3000 ms') }]);
    expect(report.complete).toBe(false);

    serve((u) => ({ body: u.includes('/user') ? { id: 42 } : [mr(1)] }));
    const calm = await new GitLabFetcher().fetchWithReport({ token: 't', projectId: 'g/p', timeBudgetMs: 60_000 });
    expect(calm.report.skips).toEqual([]);
  });
});

describe('GitLab fetchOne', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('a merge request URL is one request, mapped like an imported item', async () => {
    const urls = serve((u) => (u.endsWith('/projects/g%2Fsub%2Fp/merge_requests/3') ? { body: mr(3, { web_url: 'https://gitlab.com/g/sub/p/-/merge_requests/3' }) } : { status: 404 }));
    const { item, skip } = await new GitLabFetcher().fetchOne('https://gitlab.com/g/sub/p/-/merge_requests/3/diffs', { token: 't' });
    expect(skip).toBeUndefined();
    expect(urls).toEqual(['https://gitlab.com/api/v4/projects/g%2Fsub%2Fp/merge_requests/3']);
    expect(item).toEqual({
      source_url: 'https://gitlab.com/g/sub/p/-/merge_requests/3',
      platform: 'gitlab',
      raw_text: 'MR 3\n\nwhy\n\nStatus: merged',
      title: 'MR 3',
      created_at: '2026-03-01T00:00:00.000Z',
      updated_at: '2026-03-05T00:00:00.000Z',
      source_key: 'https://gitlab.com/g/sub/p/-/merge_requests/3',
    });
  });

  it('a self-hosted domain is read only when it is the configured one', async () => {
    const urls = serve(() => ({ body: mr(3, { web_url: 'https://git.acme.io/g/p/-/merge_requests/3' }) }));
    expect((await new GitLabFetcher().fetchOne('https://git.acme.io/g/p/-/merge_requests/3', { token: 't', domain: 'git.acme.io' })).item).toBeDefined();
    expect(urls).toEqual(['https://git.acme.io/api/v4/projects/g%2Fp/merge_requests/3']);
  });

  it('401 is an auth skip and 404 an error skip', async () => {
    serve(() => ({ status: 401, body: { message: '401 Unauthorized' } }));
    expect((await new GitLabFetcher().fetchOne('https://gitlab.com/g/p/-/merge_requests/3', { token: 't' })).skip).toMatchObject({ kind: 'auth' });
    serve(() => ({ status: 404, body: { message: '404 Not found' } }));
    expect((await new GitLabFetcher().fetchOne('https://gitlab.com/g/p/-/merge_requests/3', { token: 't' })).skip).toMatchObject({ kind: 'error' });
  });

  it.each([
    'https://gitlab.com/g/p/-/merge_requests/abc',
    'https://gitlab.com/g/p/-/issues/3',
    'https://git.acme.io/g/p/-/merge_requests/3', // not the configured domain: the token must not go there
    'nope',
  ])('%s is a shape skip with no request', async (url) => {
    const urls = serve(() => ({ body: {} }));
    expect(await new GitLabFetcher().fetchOne(url, { token: 't' })).toEqual({ skip: { kind: 'shape', count: 1, detail: expect.any(String) } });
    expect(urls).toEqual([]);
  });
});
