/**
 * S2 Jira: team scope on named projects, `since`/`until` as JQL `updated` bounds
 * (https://support.atlassian.com/jira-software-cloud/docs/jql-fields/, endpoint
 * https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/),
 * page errors as skips, the time budget, and fetchOne. Synthetic responses; no live call.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { JiraFetcher } from '../fetchers/jira.js';
import { fakeClockForTests } from '../fetchers/util/pace.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const res = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) }) as unknown as Awaited<
    ReturnType<typeof fetch>
  >;

const issue = (key: string) => ({
  key,
  fields: {
    summary: `Summary ${key}`,
    description: null,
    status: { name: 'Done' },
    created: '2026-03-01T09:00:00.000+0000',
    updated: '2026-03-04T09:00:00.000+0000',
    reporter: { displayName: 'Ada' },
  },
});

const OAUTH = { token: 't', cloudId: 'cid', siteBase: 'https://acme.atlassian.net' };

function serve(route: (url: string, body: Record<string, unknown>) => { status?: number; body?: unknown }) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  mockFetch.mockImplementation(async (input: unknown, init?: { body?: unknown }) => {
    if (input === undefined) return res({});
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url: String(input), body });
    const out = route(String(input), body);
    return res(out.body ?? {}, out.status ?? 200);
  });
  return calls;
}

describe('Jira team scope and since', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('projects + since: project in (...) AND updated >= "D", newest first, scope team', async () => {
    const calls = serve(() => ({ body: { issues: [issue('ALI-1')], isLast: true } }));
    const { report } = await new JiraFetcher().fetchWithReport({ ...OAUTH, projects: ['ALI'], since: '2026-04-10T12:00:00Z' });
    // D is the day BEFORE since: a JQL date is read in the user's profile timezone, so the
    // UTC date could start up to 14 hours late. One day early never misses an item.
    expect(calls[0]!.body.jql).toBe('project in (ALI) AND updated >= "2026-04-09" ORDER BY updated DESC');
    expect(report.scope).toBe('team');
  });

  it('two projects and an until', async () => {
    const calls = serve(() => ({ body: { issues: [], isLast: true } }));
    await new JiraFetcher().fetch({ ...OAUTH, projects: ['ALI', 'ENG'], since: '2026-04-10T00:00:00Z', until: '2026-05-01T00:00:00Z' });
    expect(calls[0]!.body.jql).toBe('project in (ALI, ENG) AND updated >= "2026-04-09" AND updated < "2026-05-02" ORDER BY updated DESC');
  });

  it('no projects: the caller\'s own JQL, bounded by since, scope yours', async () => {
    const calls = serve(() => ({ body: { issues: [], isLast: true } }));
    const { report } = await new JiraFetcher().fetchWithReport({ ...OAUTH, since: '2026-04-10T00:00:00Z' });
    expect(calls[0]!.body.jql).toBe('(assignee = currentUser() OR reporter = currentUser()) AND updated >= "2026-04-09" ORDER BY updated DESC');
    expect(report.scope).toBe('yours');
  });

  it('no projects and no since is the JQL it always was', async () => {
    const calls = serve(() => ({ body: { issues: [], isLast: true } }));
    await new JiraFetcher().fetch(OAUTH);
    expect(calls[0]!.body.jql).toBe('assignee = currentUser() OR reporter = currentUser() ORDER BY updated DESC');
  });

  it('a project key that is not a Jira key is refused before any request (it would be JQL)', async () => {
    const calls = serve(() => ({ body: { issues: [], isLast: true } }));
    await expect(new JiraFetcher().fetch({ ...OAUTH, projects: ['ALI) OR project in (SECRET'] })).rejects.toThrow(/project key/);
    expect(calls).toEqual([]);
  });

  it('asks for the updated field and returns it as updated_at, with the source_key', async () => {
    const calls = serve(() => ({ body: { issues: [issue('ALI-1')], isLast: true } }));
    const { items, report } = await new JiraFetcher().fetchWithReport(OAUTH);
    expect(calls[0]!.body.fields).toContain('updated');
    expect(items[0]).toMatchObject({ updated_at: '2026-03-04T09:00:00.000Z', source_key: 'https://acme.atlassian.net/browse/ALI-1' });
    expect(report.highWater).toBe('2026-03-04T09:00:00.000Z');
  });

  it('a failed later page is an error skip that keeps what was read; a failed first page still throws', async () => {
    serve((_u, body) => (body.nextPageToken ? { status: 500, body: { errorMessages: ['boom'] } } : { body: { issues: [issue('ALI-1')], nextPageToken: 'n2' } }));
    const { items, report } = await new JiraFetcher().fetchWithReport({ ...OAUTH, limit: 500 });
    expect(items).toHaveLength(1);
    expect(report.skips).toEqual([{ kind: 'error', count: 1, detail: expect.stringContaining('500') }]);
    expect(report.complete).toBe(false);

    serve(() => ({ status: 500, body: { errorMessages: ['boom'] } }));
    await expect(new JiraFetcher().fetch(OAUTH)).rejects.toThrow(/Jira API failed \(500\)/);
  });

  it('stops at timeBudgetMs with a time_budget skip', async () => {
    const clock = fakeClockForTests();
    serve(() => {
      clock.advance(5_000);
      return { body: { issues: [issue('ALI-1')], nextPageToken: 'more' } };
    });
    const { report } = await new JiraFetcher().fetchWithReport({ ...OAUTH, limit: 500, timeBudgetMs: 4_000, clock });
    expect(report.skips).toEqual([{ kind: 'time_budget', count: 1, detail: expect.stringContaining('4000 ms') }]);
    expect(report.complete).toBe(false);
  });
});

describe('Jira fetchOne', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('/browse/KEY on the OAuth site is one request to the cloud API, mapped like an imported item', async () => {
    const calls = serve(() => ({ body: issue('ALI-1') }));
    const { item, skip } = await new JiraFetcher().fetchOne('https://acme.atlassian.net/browse/ALI-1?focusedCommentId=9', OAUTH);
    expect(skip).toBeUndefined();
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.atlassian.com/ex/jira/cid/rest/api/3/issue/ALI-1?fields=summary,description,status,reporter,created,updated',
    ]);
    expect(item).toEqual({
      source_url: 'https://acme.atlassian.net/browse/ALI-1',
      platform: 'jira',
      raw_text: '[ALI-1] Summary ALI-1\n\nStatus: Done',
      title: '[ALI-1] Summary ALI-1',
      created_at: '2026-03-01T09:00:00.000Z',
      updated_at: '2026-03-04T09:00:00.000Z',
      source_key: 'https://acme.atlassian.net/browse/ALI-1',
      author: { name: 'Ada' },
    });
  });

  it('basic auth reads the configured domain', async () => {
    const calls = serve(() => ({ body: issue('ENG-12') }));
    const { item } = await new JiraFetcher().fetchOne('https://acme.atlassian.net/browse/ENG-12', { token: 't', domain: 'acme.atlassian.net', email: 'a@x.io' });
    expect(calls[0]!.url).toBe('https://acme.atlassian.net/rest/api/3/issue/ENG-12?fields=summary,description,status,reporter,created,updated');
    expect(item?.source_url).toBe('https://acme.atlassian.net/browse/ENG-12');
  });

  it('403 is an auth skip and 404 an error skip', async () => {
    serve(() => ({ status: 403, body: {} }));
    expect((await new JiraFetcher().fetchOne('https://acme.atlassian.net/browse/ALI-1', OAUTH)).skip).toMatchObject({ kind: 'auth' });
    serve(() => ({ status: 404, body: {} }));
    expect((await new JiraFetcher().fetchOne('https://acme.atlassian.net/browse/ALI-1', OAUTH)).skip).toMatchObject({ kind: 'error' });
  });

  it.each([
    'https://acme.atlassian.net/browse/not-a-key',
    'https://acme.atlassian.net/browse/ALI',
    'https://acme.atlassian.net/jira/software/projects/ALI/boards/1',
    'https://other.atlassian.net/browse/ALI-1', // not this token's site
    'nope',
  ])('%s is a shape skip with no request', async (url) => {
    const calls = serve(() => ({ body: {} }));
    expect(await new JiraFetcher().fetchOne(url, OAUTH)).toEqual({ skip: { kind: 'shape', count: 1, detail: expect.any(String) } });
    expect(calls).toEqual([]);
  });
});
