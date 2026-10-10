/**
 * The sync contract on every fetch report (plan S1): `complete` says whether the read
 * reached the end of what it was asked for, `scope` says whether other people's items
 * are in it, and `highWater`/`oldestReached` come only from the vendor's own updated
 * times. A watermark advances only on complete:true, so a false `true` loses data
 * forever while a false `false` costs one re-read. Every fetcher here is conservative.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { routeResponses } from './helpers/routedFetch.js';
import {
  FETCHERS,
  GitFetcher,
  buildFetchReport,
  type ConnectorFetcher,
  type ConnectorFetcherOptions,
  type FetcherItem,
  type FetchSkip,
} from '../index.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (platform: string) =>
  JSON.parse(readFileSync(join(FIXTURES_DIR, `${platform}.recorded.json`), 'utf8')) as { responses: Record<string, unknown> };

const item = (updated_at?: string): FetcherItem => ({
  source_url: 'https://example.test/x',
  platform: 'x',
  raw_text: 'x',
  ...(updated_at ? { updated_at } : {}),
});
const base = { platform: 'x', scanned: 0, requested: 10, scope: 'yours' as const };
const skip = (kind: FetchSkip['kind']): FetchSkip => ({ kind, count: 1, detail: 'x' });

describe('buildFetchReport: high water and oldest reached', () => {
  it('highWater is the latest vendor updated time and oldestReached the earliest, in either input order', () => {
    const t1 = '2026-01-01T00:00:00.000Z';
    const t2 = '2026-03-01T00:00:00.000Z';
    for (const items of [[item(t1), item(t2)], [item(t2), item(t1)]]) {
      const r = buildFetchReport(items, { ...base, skips: [], exhausted: true });
      expect(r.highWater).toBe(t2);
      expect(r.oldestReached).toBe(t1);
    }
  });

  it('compares instants, not strings, and normalises to ISO Z', () => {
    // Lexically "2026-01-01T10:00:00+05:00" sorts after "2026-01-01T06:00:00Z"; as an instant it is earlier.
    const r = buildFetchReport([item('2026-01-01T10:00:00+05:00'), item('2026-01-01T06:00:00Z')], { ...base, skips: [], exhausted: true });
    expect(r.highWater).toBe('2026-01-01T06:00:00.000Z');
    expect(r.oldestReached).toBe('2026-01-01T05:00:00.000Z');
  });

  it('is undefined with zero items, never now()', () => {
    const r = buildFetchReport([], { ...base, skips: [], exhausted: true });
    expect(r.highWater).toBeUndefined();
    expect(r.oldestReached).toBeUndefined();
    expect('highWater' in r).toBe(false);
  });

  it('ignores items with no or an unparseable updated_at instead of letting NaN vacate the max', () => {
    const t = '2026-02-01T00:00:00.000Z';
    const r = buildFetchReport([item(), item('not a date'), item(t)], { ...base, skips: [], exhausted: true });
    expect(r.highWater).toBe(t);
    expect(r.oldestReached).toBe(t);
    expect(buildFetchReport([item(), item('nope')], { ...base, skips: [], exhausted: true }).highWater).toBeUndefined();
  });
});

describe('buildFetchReport: complete', () => {
  it('is true when the read was exhausted and no skip left anything unread', () => {
    expect(buildFetchReport([], { ...base, skips: [], exhausted: true }).complete).toBe(true);
    // A shape skip is something read and set aside, not something left unread.
    expect(buildFetchReport([], { ...base, skips: [skip('shape')], exhausted: true }).complete).toBe(true);
  });

  it('is false when the read stopped before the end, even with no skip', () => {
    expect(buildFetchReport([], { ...base, skips: [], exhausted: false }).complete).toBe(false);
  });

  it.each(['page_cap', 'time_budget', 'vendor_cap', 'error', 'auth'] as const)('is false when a %s skip fired', (kind) => {
    expect(buildFetchReport([], { ...base, skips: [skip(kind)], exhausted: true }).complete).toBe(false);
  });

  it('passes platform, scanned, requested, skips and scope through unchanged', () => {
    const skips = [skip('shape')];
    const r = buildFetchReport([], { platform: 'p', scanned: 3, requested: 9, skips, scope: 'team', exhausted: true });
    expect(r).toEqual({ platform: 'p', scanned: 3, requested: 9, skips, scope: 'team', complete: true });
  });
});

/**
 * Models align-cli's real writer: `git log -n limit` scans n raw commits, then the
 * decision filters keep only some (here every other one), and the source says whether
 * the raw scan ran out before its limit.
 */
const gitSource = (n: number) => ({
  getCommitHistory: async ({ limit }: { limit: number }) => {
    const scanned = Math.min(n, limit);
    const commits = Array.from({ length: scanned }, (_, i) => ({ sha: `abc${i}`, subject: `Adopt ${i}`, date: '2026-01-01T00:00:00Z' }))
      .filter((_, i) => i % 2 === 0);
    return { commits, scanned, exhausted: scanned < limit };
  },
  getRemoteUrl: async () => null,
});

const ATLASSIAN = { token: 'tok', cloudId: 'cid', siteBase: 'https://acme.atlassian.net' };
/**
 * Scope from what each fetcher reads today. 'yours' = filtered to the caller's own items
 * (author, assignee, involves, host); 'team' = everything the token can see, other people's included.
 */
const EXPECTED_SCOPE: Record<string, 'yours' | 'team'> = {
  github: 'yours', // involves:/reviewed-by: the caller, with or without repo
  gitlab: 'yours', // author_id = the caller
  jira: 'yours', // assignee or reporter = currentUser()
  linear: 'yours', // viewer.assignedIssues / createdIssues
  zoom: 'yours', // /users/me/recordings
  confluence: 'team', // every page the token can read
  notion: 'team', // every page shared with the integration
  slack: 'team', // every thread in every channel the token can see
  teams: 'team', // every message in the caller's joined teams
  git: 'team', // every commit in the local history, any author
};

const EVERY_FETCHER: Array<{ platform: string; build: (n: number) => ConnectorFetcher; opts: ConnectorFetcherOptions }> = [
  ...Object.entries(FETCHERS).map(([platform, build]) => ({
    platform,
    build: () => build(),
    opts: platform === 'jira' || platform === 'confluence' ? ATLASSIAN : { token: 'tok', interChannelDelayMs: 0 },
  })),
  { platform: 'git', build: (n: number) => new GitFetcher(gitSource(n)), opts: { token: '' } },
];

describe.each(EVERY_FETCHER)('$platform report contract', ({ platform, build, opts }) => {
  beforeEach(() => {
    mockFetch.mockReset();
    if (platform !== 'git') routeResponses(mockFetch, fixture(platform).responses);
  });

  it('reports its scope', async () => {
    const { report } = await build(2).fetchWithReport!({ ...opts, limit: 50 });
    expect(report.scope).toBe(EXPECTED_SCOPE[platform]);
  });

  it('is complete when the recorded workspace is read to its end under a roomy limit', async () => {
    const { items, report } = await build(2).fetchWithReport!({ ...opts, limit: 50 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(50); // the limit did not stop the read
    expect(report.complete).toBe(true);
  });

  it('is not complete when the item limit stopped the read with more left', async () => {
    const { items, report } = await build(2).fetchWithReport!({ ...opts, limit: 1 });
    expect(items).toHaveLength(1);
    expect(report.complete).toBe(false);
  });

  it('never invents a high water: it is the latest item updated_at, and absent when no item carries one', async () => {
    const { items, report } = await build(2).fetchWithReport!({ ...opts, limit: 50 });
    const times = items.map((i) => i.updated_at).filter((t): t is string => t !== undefined).map((t) => Date.parse(t));
    if (times.length === 0) expect(report.highWater).toBeUndefined();
    else expect(report.highWater).toBe(new Date(Math.max(...times)).toISOString());
  });
});
