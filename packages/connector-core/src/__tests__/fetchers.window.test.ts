/**
 * A `since` or `until` that is not a date must not read an unbounded or empty window and
 * call it complete. Every windowed fetcher refuses it before any request: a `shape` skip,
 * `complete: false`, nothing read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { GitHubFetcher } from '../fetchers/github.js';
import { GitLabFetcher } from '../fetchers/gitlab.js';
import { JiraFetcher } from '../fetchers/jira.js';
import { LinearFetcher } from '../fetchers/linear.js';
import { parseWindow } from '../fetchers/util/time.js';
import type { ConnectorFetcher, ConnectorFetcherOptions } from '../types/fetcher.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

describe('parseWindow', () => {
  it('reads both bounds, in ms and as ISO', () => {
    expect(parseWindow('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z')).toEqual({
      ok: true,
      sinceMs: Date.parse('2026-03-01T00:00:00Z'),
      untilMs: Date.parse('2026-04-01T00:00:00Z'),
      since: '2026-03-01T00:00:00.000Z',
      until: '2026-04-01T00:00:00.000Z',
    });
  });
  it('treats an absent or empty bound as no bound', () => {
    expect(parseWindow(undefined, '')).toEqual({ ok: true });
  });
  it.each([
    ['last tuesday', undefined, 'since'],
    [undefined, 'garbage', 'until'],
    ['2026-03-01', 'nope', 'until'],
  ])('since %j until %j is refused and names %s', (since, until, name) => {
    const w = parseWindow(since, until);
    expect(w.ok).toBe(false);
    expect((w as { detail: string }).detail).toContain(name);
  });
});

const CASES: Array<[string, ConnectorFetcher, ConnectorFetcherOptions]> = [
  ['github', new GitHubFetcher(), { token: 't' }],
  ['github team', new GitHubFetcher(), { token: 't', repo: 'o/r', scope: 'team' }],
  ['gitlab', new GitLabFetcher(), { token: 't' }],
  ['gitlab team', new GitLabFetcher(), { token: 't', projectId: 7 }],
  ['jira', new JiraFetcher(), { token: 't', cloudId: 'c' }],
  ['linear', new LinearFetcher(), { token: 't' }],
];

describe.each(CASES)('%s with an unparseable window', (_name, fetcher, base) => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error('no request may be made'));
  });

  it.each([
    ['since', { since: 'last tuesday' }],
    ['until', { until: 'garbage' }],
    ['both', { since: '2026-03-01T00:00:00Z', until: 'garbage' }],
  ])('%s: a shape skip, not complete, nothing requested', async (_which, bound) => {
    const { items, report } = await fetcher.fetchWithReport!({ ...base, ...bound });
    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(items).toEqual([]);
    expect(report.complete).toBe(false);
    expect(report.skips).toEqual([{ kind: 'shape', count: 1, detail: expect.stringMatching(/since|until/) }]);
  });
});
