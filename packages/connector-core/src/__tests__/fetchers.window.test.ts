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

const LENIENT = ['0', '1', '32', 'foo 1', 'x 2020', '1/2', '2026-02-30', '2026-03-01T00:00:00', '2026-03-01 00:00:00', '+100000-01-01T00:00:00Z', '1969-12-31T23:59:59Z', '2101-01-01', '2026-13-01', '2026-03-01T25:00:00Z', 'March 1 2026'];

describe('parseWindow is strict ISO-8601, not whatever V8 will swallow', () => {
  it.each(LENIENT)('%j is refused as since and as until', (bad) => {
    expect(parseWindow(bad, undefined).ok).toBe(false);
    expect(parseWindow(undefined, bad).ok).toBe(false);
  });
  it.each(['2026-03-01T00:00:00Z', '2026-03-01', '2026-03-01T09:30:00+01:00', '2026-03-01T00:00:00.123Z', '2024-02-29'])('%j is accepted', (good) => {
    expect(parseWindow(good, undefined).ok).toBe(true);
  });
  it('a date-only bound is that UTC day', () => {
    expect(parseWindow('2026-03-01', undefined)).toMatchObject({ ok: true, since: '2026-03-01T00:00:00.000Z' });
  });
});

describe.each(CASES)('%s refuses a lenient window before any request', (_name, fetcher, base) => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error('no request may be made'));
  });
  it.each(LENIENT)('since %j', async (bad) => {
    const { report } = await fetcher.fetchWithReport!({ ...base, since: bad });
    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(report.complete).toBe(false);
    expect(report.skips[0]).toMatchObject({ kind: 'shape' });
  });
});

describe('parseWindow ordering and the future', () => {
  it.each([
    ['2026-04-01T00:00:00Z', '2026-03-01T00:00:00Z'],
    ['2026-03-01T00:00:00Z', '2026-03-01T00:00:00Z'],
  ])('until <= since (%s, %s) is refused', (since, until) => {
    const w = parseWindow(since, until);
    expect(w.ok).toBe(false);
    expect((w as { detail: string }).detail).toContain('until');
  });
  it('a since more than a day in the future is refused; a since within a day is accepted', () => {
    expect(parseWindow('2099-01-01', undefined).ok).toBe(false);
    expect(parseWindow(new Date(Date.now() + 3_600_000).toISOString(), undefined).ok).toBe(true);
  });
});

describe.each(CASES)('%s refuses an empty or future window before any request', (_name, fetcher, base) => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockRejectedValue(new Error('no request may be made'));
  });
  it.each([
    [{ since: '2026-04-01T00:00:00Z', until: '2026-03-01T00:00:00Z' }],
    [{ since: '2099-01-01T00:00:00Z' }],
  ])('%j', async (bounds) => {
    const { report } = await fetcher.fetchWithReport!({ ...base, ...bounds });
    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(report.complete).toBe(false);
    expect(report.skips[0]).toMatchObject({ kind: 'shape' });
  });
});
