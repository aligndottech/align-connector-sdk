/**
 * The fetch report holds for EVERY fetcher, including the six ALI-828 did not page:
 * `fetch()` is `(await fetchWithReport()).items` (one implementation, two entry
 * points), and every report names its platform and counts at least as many
 * scanned objects as it returned items. The golden fixtures serve as the
 * workspaces here, so the report smoke runs over the same recorded shapes the
 * byte-identity test does.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { routeResponses } from './helpers/routedFetch.js';
import { FETCHERS, GitFetcher, type ConnectorFetcher, type ConnectorFetcherOptions, type FetcherItem } from '../index.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = (platform: string) =>
  JSON.parse(readFileSync(join(FIXTURES_DIR, `${platform}.recorded.json`), 'utf8')) as { responses: Record<string, unknown> };

const gitSource = {
  getCommitHistory: async () => [{ sha: 'abc', subject: 'Adopt hexagonal architecture', date: '2026-01-01T00:00:00Z' }],
  getRemoteUrl: async () => null,
};

const ATLASSIAN = { token: 'tok', cloudId: 'cid', siteBase: 'https://acme.atlassian.net' };
const EVERY_FETCHER: Array<{ platform: string; build: () => ConnectorFetcher; opts: ConnectorFetcherOptions }> = [
  ...Object.entries(FETCHERS).map(([platform, build]) => ({
    platform,
    build,
    opts: platform === 'jira' || platform === 'confluence' ? ATLASSIAN : { token: 'tok', interChannelDelayMs: 0 },
  })),
  { platform: 'git', build: () => new GitFetcher(gitSource), opts: { token: '' } },
];

describe.each(EVERY_FETCHER)('$platform fetch report', ({ platform, build, opts }) => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('fetch() returns exactly what fetchWithReport() returned', async () => {
    // R22a. Spied rather than served: this pins the delegation, not the read.
    const fetcher = build();
    const sentinel: FetcherItem[] = [{ source_url: 'https://example.test/1', platform, raw_text: 'x' }];
    const spy = vi.spyOn(fetcher as Required<ConnectorFetcher>, 'fetchWithReport').mockResolvedValue({
      items: sentinel,
      report: { platform, scanned: 1, skips: [] },
    });
    const items = await fetcher.fetch(opts);
    expect(spy).toHaveBeenCalledWith(opts);
    expect(items).toBe(sentinel);
  });

  it('names its platform and scans at least as many objects as it returns', async () => {
    if (platform !== 'git') routeResponses(mockFetch, fixture(platform).responses);
    const { items, report } = await build().fetchWithReport!({ ...opts, limit: 50 });
    expect(items.length).toBeGreaterThan(0); // the fixture is not empty, so scanned >= items is not vacuous
    expect(report.platform).toBe(platform);
    expect(report.requested).toBe(50);
    expect(report.scanned).toBeGreaterThanOrEqual(items.length);
  });
});
