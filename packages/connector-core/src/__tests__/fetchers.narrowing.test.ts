/**
 * Narrowing a team read to part of a project or team, for a person whose team shares one Jira
 * project (one board inside it) or one Linear team (one project inside it).
 *
 * Test List:
 * - Jira `jql` is parenthesised and ANDed after `project in (...)` and before the window bounds,
 *   so it can only narrow the projects already chosen (a label; an OR between components).
 * - A trailing ORDER BY (every board filter has one) is dropped, case-insensitively.
 * - A fragment with unbalanced parentheses or quotes is refused before any request: it could
 *   close the project clause and widen the read. Parentheses inside quotes do not count.
 * - A fragment without projects is refused: it narrows a team read, it never stands alone.
 * - An empty or whitespace fragment is exactly today's JQL.
 * - Linear `projects` narrows a team read: the filter carries the team AND the project ids.
 * - Linear `projects` without `teams` is refused before any request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { JiraFetcher } from '../fetchers/jira.js';
import { LinearFetcher } from '../fetchers/linear.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const res = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Awaited<ReturnType<typeof fetch>>;

function serve(body: unknown): Array<Record<string, unknown>> {
  const sent: Array<Record<string, unknown>> = [];
  mockFetch.mockImplementation(async (input: unknown, init?: { body?: unknown }) => {
    if (input === undefined) return res({});
    sent.push(typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {});
    return res(body);
  });
  return sent;
}

const OAUTH = { token: 't', cloudId: 'cid', siteBase: 'https://acme.atlassian.net' };
const jiraEmpty = { issues: [], isLast: true };

describe('Jira: a JQL fragment narrows the chosen projects', () => {
  beforeEach(() => mockFetch.mockReset());

  it('a label is parenthesised and ANDed after the project, before the window', async () => {
    const sent = serve(jiraEmpty);
    await new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'labels = payments', since: '2026-04-10T00:00:00Z' });
    expect(sent[0]!.jql).toBe('project in (AC) AND (labels = payments) AND updated >= "2026-04-09" ORDER BY updated DESC');
  });

  it('an OR stays inside the parentheses, so it cannot reach past the project', async () => {
    const sent = serve(jiraEmpty);
    await new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'component = Billing OR component = Payouts' });
    expect(sent[0]!.jql).toBe('project in (AC) AND (component = Billing OR component = Payouts) ORDER BY updated DESC');
  });

  it("a board filter's own ORDER BY is dropped, whatever its case", async () => {
    const sent = serve(jiraEmpty);
    await new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'project = AC AND team = 42 ORDER BY Rank ASC' });
    expect(sent[0]!.jql).toBe('project in (AC) AND (project = AC AND team = 42) ORDER BY updated DESC');
    await new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'labels = x order by created' });
    expect(sent[1]!.jql).toBe('project in (AC) AND (labels = x) ORDER BY updated DESC');
  });

  it('unbalanced parentheses are refused before any request', async () => {
    const sent = serve(jiraEmpty);
    await expect(new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'labels = a) OR (project = SECRET' })).rejects.toThrow(/JQL/);
    expect(sent).toEqual([]);
  });

  it('an unclosed quote is refused before any request', async () => {
    const sent = serve(jiraEmpty);
    await expect(new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'summary ~ "half' })).rejects.toThrow(/JQL/);
    expect(sent).toEqual([]);
  });

  // Jira may read curly quotes as string delimiters, which this check would not see, so parentheses
  // hidden inside them could close the project clause. Refused, never guessed at.
  it('curly quotes are refused before any request', async () => {
    const sent = serve(jiraEmpty);
    await expect(new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'labels = \u201c(\u201d ) OR project = SECRET OR (\u201c)\u201d' })).rejects.toThrow(/JQL/);
    await expect(new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'summary ~ \u2018x\u2019' })).rejects.toThrow(/JQL/);
    expect(sent).toEqual([]);
  });

  it('a backslash outside quotes is refused before any request', async () => {
    const sent = serve(jiraEmpty);
    await expect(new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'a \\( ) OR project = SECRET OR ( \\)' })).rejects.toThrow(/JQL/);
    await expect(new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'labels = a \\' })).rejects.toThrow(/JQL/);
    expect(sent).toEqual([]);
  });

  it('a backslash escape inside quotes is still allowed', async () => {
    const sent = serve(jiraEmpty);
    await new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'summary ~ "say \\"hi\\""' });
    expect(sent[0]!.jql).toBe('project in (AC) AND (summary ~ "say \\"hi\\"") ORDER BY updated DESC');
  });

  it('a parenthesis inside quotes does not count', async () => {
    const sent = serve(jiraEmpty);
    await new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: 'summary ~ "a)"' });
    expect(sent[0]!.jql).toBe('project in (AC) AND (summary ~ "a)") ORDER BY updated DESC');
  });

  it('a fragment with no projects is refused before any request', async () => {
    const sent = serve(jiraEmpty);
    await expect(new JiraFetcher().fetch({ ...OAUTH, jql: 'labels = payments' })).rejects.toThrow(/project/);
    expect(sent).toEqual([]);
  });

  it('an empty or blank fragment is exactly today\'s JQL', async () => {
    const sent = serve(jiraEmpty);
    await new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: '' });
    await new JiraFetcher().fetch({ ...OAUTH, projects: ['AC'], jql: '   ' });
    expect(sent.map((s) => s.jql)).toEqual(['project in (AC) ORDER BY updated DESC', 'project in (AC) ORDER BY updated DESC']);
  });
});

const linearEmpty = { data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };

describe('Linear: projects narrow the chosen teams', () => {
  beforeEach(() => mockFetch.mockReset());

  it('the filter carries the team and the project ids', async () => {
    const sent = serve(linearEmpty);
    await new LinearFetcher().fetch({ token: 'lin_api_x', teams: ['team-1'], projects: ['proj-a', 'proj-b'] });
    expect((sent[0]!.variables as Record<string, unknown>).filter).toEqual({ team: { id: { in: ['team-1'] } }, project: { id: { in: ['proj-a', 'proj-b'] } } });
  });

  it('the window still applies beside the team and project', async () => {
    const sent = serve(linearEmpty);
    await new LinearFetcher().fetch({ token: 'lin_api_x', teams: ['team-1'], projects: ['proj-a'], since: '2026-03-01T00:00:00Z' });
    expect((sent[0]!.variables as Record<string, unknown>).filter).toEqual({
      team: { id: { in: ['team-1'] } },
      project: { id: { in: ['proj-a'] } },
      updatedAt: { gte: '2026-03-01T00:00:00.000Z' },
    });
  });

  it('an empty project id is refused before any request', async () => {
    const sent = serve(linearEmpty);
    await expect(new LinearFetcher().fetch({ token: 'lin_api_x', teams: ['team-1'], projects: [''] })).rejects.toThrow(/project/);
    await expect(new LinearFetcher().fetch({ token: 'lin_api_x', teams: ['team-1'], projects: ['proj-a', '  '] })).rejects.toThrow(/project/);
    expect(sent).toEqual([]);
  });

  it('projects without teams are refused before any request', async () => {
    const sent = serve(linearEmpty);
    await expect(new LinearFetcher().fetch({ token: 'lin_api_x', projects: ['proj-a'] })).rejects.toThrow(/team/);
    expect(sent).toEqual([]);
  });
});
