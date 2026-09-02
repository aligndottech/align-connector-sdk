/**
 * Every item carries the source's own date as `created_at` (ALI-828 phase 5),
 * one case per fetcher so a failure names the fetcher. Absent means absent:
 * a fetcher never substitutes "now".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { routeResponses } from './helpers/routedFetch.js';
import { toIsoOrUndefined } from '../fetchers/util/time.js';
import { ConfluenceFetcher } from '../fetchers/confluence.js';
import { GitFetcher } from '../fetchers/git.js';
import { GitHubFetcher } from '../fetchers/github.js';
import { GitLabFetcher } from '../fetchers/gitlab.js';
import { JiraFetcher } from '../fetchers/jira.js';
import { LinearFetcher } from '../fetchers/linear.js';
import { NotionFetcher } from '../fetchers/notion.js';
import { SlackFetcher } from '../fetchers/slack.js';
import { TeamsFetcher } from '../fetchers/teams.js';
import { ZoomFetcher } from '../fetchers/zoom.js';
import type { FetcherItem } from '../index.js';

const route = (responses: Record<string, unknown>) => routeResponses(mockFetch, responses).calls;

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

describe('toIsoOrUndefined', () => {
  it.each([
    ['an ISO string with a colon-less offset (Jira)', '2026-03-01T09:00:00.000+0000', '2026-03-01T09:00:00.000Z'],
    ['an ISO string with a colon offset (git)', '2026-01-11T08:30:00+01:00', '2026-01-11T07:30:00.000Z'],
    ['an ISO string already in Z form', '2026-01-09T08:30:00.123Z', '2026-01-09T08:30:00.123Z'],
    ['epoch milliseconds as a number (Slack ts * 1000)', 1712345678000.1, '2024-04-05T19:34:38.000Z'],
  ])('normalises %s to ISO-8601 Z', (_label, input, expected) => {
    expect(toIsoOrUndefined(input)).toBe(expected);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['prose', 'yesterday'],
    ['NaN', Number.NaN],
    ['a numeric zero (Number of a blank string)', 0],
  ])('returns undefined for %s rather than a fabricated now', (_label, input) => {
    expect(toIsoOrUndefined(input)).toBeUndefined();
  });
});

const SLACK_ROOT = { ts: '1712345678.000100', user: 'U1', text: 'root', reply_count: 2 };
const slackResponses = {
  'auth.test': { ok: true },
  'conversations.list': { ok: true, channels: [{ id: 'C1', name: 'eng' }], response_metadata: { next_cursor: '' } },
  'conversations.history': { ok: true, messages: [SLACK_ROOT], response_metadata: { next_cursor: '' } },
  'conversations.replies': {
    ok: true,
    messages: [{ ts: '1712345678.000100', user: 'U1', text: 'root' }, { ts: '1712345700.000200', user: 'U1', text: 'reply' }],
    response_metadata: { next_cursor: '' },
  },
  'users.info': { ok: true, user: { name: 'ada', real_name: 'Ada L' } },
};

const githubResponses = (created_at?: string) => ({
  'api.github.com/user': { login: 'ada' },
  'search/issues?q=involves:ada+type:pr': {
    items: [{ html_url: 'https://github.com/o/r/pull/7', number: 7, title: 'PR', body: '', state: 'closed', repository_url: 'https://api.github.com/repos/o/r', ...(created_at ? { created_at } : {}) }],
  },
  'search/issues?q=reviewed-by:ada+type:pr': { items: [] },
  'search/issues?q=involves:ada+type:issue': { items: [] },
  '/repos/o/r/': [],
});

const CASES: Array<{ platform: string; expected: string; run: () => Promise<FetcherItem[]> }> = [
  {
    platform: 'slack',
    expected: '2024-04-05T19:34:38.000Z',
    run: () => {
      route(slackResponses);
      return new SlackFetcher().fetch({ token: 't', interChannelDelayMs: 0 });
    },
  },
  {
    platform: 'jira',
    expected: '2026-03-01T09:00:00.000Z',
    run: () => {
      route({ 'search/jql': { issues: [{ key: 'ENG-1', fields: { summary: 's', created: '2026-03-01T09:00:00.000+0000' } }], isLast: true } });
      return new JiraFetcher().fetch({ token: 't', cloudId: 'c', siteBase: 'https://acme.atlassian.net' });
    },
  },
  {
    platform: 'github',
    expected: '2026-02-02T10:00:00.000Z',
    run: () => {
      route(githubResponses('2026-02-02T10:00:00Z'));
      return new GitHubFetcher().fetch({ token: 't' });
    },
  },
  {
    platform: 'confluence',
    expected: '2026-01-05T08:30:00.000Z',
    run: () => {
      route({
        // Both dates present, deliberately different: the fetcher reads the current version's
        // date (the page as it now stands), matching the hosted scan's decided_at for Confluence.
        '/api/v2/pages': { results: [{ title: 'P', createdAt: '2020-06-01T00:00:00Z', version: { createdAt: '2026-01-05T08:30:00Z' }, _links: { webui: '/p/1' } }], _links: { base: 'https://acme.atlassian.net/wiki' } },
      });
      return new ConfluenceFetcher().fetch({ token: 't', cloudId: 'c' });
    },
  },
  {
    platform: 'notion',
    expected: '2026-01-06T08:30:00.000Z',
    run: () => {
      route({
        '/v1/search': { results: [{ id: 'abc', created_time: '2026-01-06T08:30:00.000Z', properties: { title: { title: [{ plain_text: 'Spec' }] } } }], has_more: false },
        '/blocks/': { results: [] },
      });
      return new NotionFetcher().fetch({ token: 't' });
    },
  },
  {
    platform: 'linear',
    expected: '2026-01-07T08:30:00.000Z',
    run: () => {
      const node = { id: 'i1', createdAt: '2026-01-07T08:30:00.000Z', title: 'T', description: '', url: 'https://linear.app/i1' };
      const noMore = { hasNextPage: false, endCursor: null };
      route({
        'graphql & assignedIssues': { data: { viewer: { assignedIssues: { nodes: [node], pageInfo: noMore } } } },
        'graphql & createdIssues': { data: { viewer: { createdIssues: { nodes: [], pageInfo: noMore } } } },
      });
      return new LinearFetcher().fetch({ token: 't' });
    },
  },
  {
    platform: 'gitlab',
    expected: '2026-01-08T08:30:00.000Z',
    run: () => {
      route({
        '/api/v4/user': { id: 42 },
        '/merge_requests': [{ web_url: 'https://gitlab.com/g/p/-/merge_requests/3', title: 'MR', description: '', state: 'merged', created_at: '2026-01-08T08:30:00.000Z' }],
      });
      return new GitLabFetcher().fetch({ token: 't' });
    },
  },
  {
    platform: 'teams',
    expected: '2026-01-09T08:30:00.000Z',
    run: () => {
      route({
        '/me/joinedTeams': { value: [{ id: 'T1', displayName: 'Platform' }] },
        '/teams/T1/channels': { value: [{ id: 'CH1', displayName: 'General' }] },
        '/teams/T1/channels/CH1/messages': { value: [{ id: 'm1', createdDateTime: '2026-01-09T08:30:00Z', subject: 'S', body: { content: 'x', contentType: 'text' } }] },
      });
      return new TeamsFetcher().fetch({ token: 't' });
    },
  },
  {
    platform: 'zoom',
    expected: '2026-01-10T08:30:00.000Z',
    run: () => {
      route({
        '/users/me/recordings': {
          meetings: [{ uuid: 'u', topic: 'T', start_time: '2026-01-10T08:30:00Z', recording_files: [{ file_type: 'TRANSCRIPT', status: 'completed', download_url: 'https://zoom.us/dl/1' }] }],
        },
        '/dl/1': 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:03.000\nhello\n',
      });
      return new ZoomFetcher().fetch({ token: 't' });
    },
  },
  {
    platform: 'git',
    expected: '2026-01-11T07:30:00.000Z',
    run: () =>
      new GitFetcher({
        getCommitHistory: async () => [{ sha: 'abc', subject: 'Adopt hexagonal architecture', date: '2026-01-11T08:30:00+01:00' }],
        getRemoteUrl: async () => null,
      }).fetch({ token: '' }),
  },
];

describe('every fetcher carries the source timestamp as created_at', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it.each(CASES)('$platform', async ({ expected, run }) => {
    const items = await run();
    expect(items).toHaveLength(1);
    expect(items[0].created_at).toBe(expected);
  });

  it('jira asks the search API for the created field, or it is not returned', async () => {
    const calls = route({ 'search/jql': { issues: [], isLast: true } });
    await new JiraFetcher().fetch({ token: 't', cloudId: 'c' });
    expect(JSON.parse(calls[0].body).fields).toContain('created');
  });

  it('linear selects createdAt in the issue fields', async () => {
    const noMore = { hasNextPage: false, endCursor: null };
    const calls = route({
      'graphql & assignedIssues': { data: { viewer: { assignedIssues: { nodes: [], pageInfo: noMore } } } },
      'graphql & createdIssues': { data: { viewer: { createdIssues: { nodes: [], pageInfo: noMore } } } },
    });
    await new LinearFetcher().fetch({ token: 't' });
    expect(JSON.parse(calls[0].body).query).toContain('createdAt');
  });
});

describe('an absent or unreadable source date leaves no created_at key', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('gitlab: a merge request with no created_at', async () => {
    // R17a. Absent, never a fabricated "now".
    route({ '/api/v4/user': { id: 42 }, '/merge_requests': [{ web_url: 'https://gitlab.com/m/1', title: 'MR', description: '', state: 'merged' }] });
    const items = await new GitLabFetcher().fetch({ token: 't' });
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('created_at');
  });

  it('teams: a message with no createdDateTime', async () => {
    // R17b. Teams rather than the plan's Zoom: a Zoom meeting with no start_time
    // already has no title today and is skipped whole, so it cannot show this.
    route({
      '/me/joinedTeams': { value: [{ id: 'T1', displayName: 'Platform' }] },
      '/teams/T1/channels': { value: [{ id: 'CH1', displayName: 'General' }] },
      '/teams/T1/channels/CH1/messages': { value: [{ id: 'm1', subject: 'S', body: { content: 'x', contentType: 'text' } }] },
    });
    const items = await new TeamsFetcher().fetch({ token: 't' });
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('created_at');
  });

  it('gitlab: a created_at the platform sent but nothing can parse', async () => {
    // The NaN branch, reached through a fetcher rather than the helper alone.
    route({ '/api/v4/user': { id: 42 }, '/merge_requests': [{ web_url: 'https://gitlab.com/m/1', title: 'MR', description: '', state: 'merged', created_at: 'yesterday' }] });
    const items = await new GitLabFetcher().fetch({ token: 't' });
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty('created_at');
  });
});
