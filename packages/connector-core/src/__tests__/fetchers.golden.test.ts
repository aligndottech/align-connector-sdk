/**
 * Golden fixtures: the byte-identity contract for every HTTP fetcher.
 *
 * Each `fixtures/<platform>.recorded.json` holds API responses keyed by request
 * substring plus the `expected` items those responses produced on the fetcher
 * as it stood when the fixture was recorded. A behaviour change is allowed to
 * REMOVE an entry (a filter) or ADD one (pagination reaching a page it could
 * not before); no kept entry's bytes may move. That makes the fixture diff the
 * review surface for ALI-828, and it is why the fixtures were committed against
 * unchanged 0.5.0 code before any fetcher changed - recorded after the fact
 * they would prove nothing.
 *
 * `created_at` is stripped before comparing rather than baked into the
 * fixture, so the phase that adds it cannot rewrite the contract it is being
 * judged against.
 *
 * Regenerate deliberately, with the reason in the commit message:
 *   GOLDEN_RECORD=1 pnpm --filter @aligndottech/connector-core exec vitest run fetchers.golden
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem } from '../index.js';
import {
  ConfluenceFetcher,
  GitHubFetcher,
  GitLabFetcher,
  JiraFetcher,
  LinearFetcher,
  NotionFetcher,
  SlackFetcher,
  TeamsFetcher,
  ZoomFetcher,
} from '../fetchers/index.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const RECORD = process.env.GOLDEN_RECORD === '1';

interface RecordedFixture {
  note: string;
  responses: Record<string, unknown>;
  expected: FetcherItem[];
}

function fixturePath(platform: string): string {
  return join(FIXTURES_DIR, `${platform}.recorded.json`);
}

function loadFixture(platform: string): RecordedFixture {
  // A missing file throws here, loudly. It must never read as an empty fixture.
  return JSON.parse(readFileSync(fixturePath(platform), 'utf8')) as RecordedFixture;
}

/**
 * Serve recorded responses from the mocked `fetch`.
 *
 * A key is one or more ` & `-separated substrings that must ALL appear in the
 * request (the URL, a newline, then the body). The most specific key wins:
 * most parts first, then the longest key, so `conversations.list & cursor=P2`
 * beats `conversations.list` for the second page and `/teams/T1/channels/CH1/messages`
 * beats `/teams/T1/channels`. Order in the JSON file never matters.
 *
 * A request nothing anticipated throws AND is collected, so the test can name
 * it. Throwing alone is not enough: several fetchers swallow a failed lookup
 * (a Slack `users.info`, a Notion block read) and would quietly produce an
 * item with less in it.
 */
function serveRecorded(responses: Record<string, unknown>): { unmatched: string[] } {
  const unmatched: string[] = [];
  const rules = Object.entries(responses).map(([key, body]) => ({ key, parts: key.split(' & '), body }));
  mockFetch.mockImplementation((async (input: unknown, init?: { body?: unknown }) => {
    const haystack = `${String(input)}\n${typeof init?.body === 'string' ? init.body : ''}`;
    const hits = rules
      .filter((r) => r.parts.every((p) => haystack.includes(p)))
      .sort((a, b) => b.parts.length - a.parts.length || b.key.length - a.key.length);
    const hit = hits[0];
    if (!hit) {
      unmatched.push(String(input));
      throw new Error(`golden fixture has no response for ${String(input)}`);
    }
    const body = hit.body;
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    };
  }) as never);
  return { unmatched };
}

function stripCreatedAt(item: FetcherItem): Record<string, unknown> {
  return Object.fromEntries(Object.entries(item).filter(([k]) => k !== 'created_at'));
}

const GOLDEN_CASES: Array<{ platform: string; build: () => ConnectorFetcher; opts: ConnectorFetcherOptions }> = [
  { platform: 'slack', build: () => new SlackFetcher(), opts: { token: 'tok', interChannelDelayMs: 0 } },
  { platform: 'teams', build: () => new TeamsFetcher(), opts: { token: 'tok' } },
  { platform: 'zoom', build: () => new ZoomFetcher(), opts: { token: 'tok' } },
  { platform: 'gitlab', build: () => new GitLabFetcher(), opts: { token: 'tok' } },
  { platform: 'github', build: () => new GitHubFetcher(), opts: { token: 'tok' } },
  { platform: 'notion', build: () => new NotionFetcher(), opts: { token: 'tok' } },
  { platform: 'linear', build: () => new LinearFetcher(), opts: { token: 'tok' } },
  { platform: 'jira', build: () => new JiraFetcher(), opts: { token: 'tok', cloudId: 'cid', siteBase: 'https://acme.atlassian.net' } },
  {
    platform: 'confluence',
    build: () => new ConfluenceFetcher(),
    opts: { token: 'tok', cloudId: 'cid', siteBase: 'https://acme.atlassian.net' },
  },
];

describe.each(GOLDEN_CASES)('$platform golden fixture', ({ platform, build, opts }) => {
  beforeEach(() => {
    // Braces on purpose: vitest treats a value RETURNED from beforeEach as a
    // cleanup hook and calls it after the test with no arguments. mockReset()
    // returns the mock itself, so the one-liner form the other test files use
    // would call the served fetch with `undefined` and this mock throws on that.
    mockFetch.mockReset();
  });

  it('produces the recorded items, byte for byte, ignoring created_at', async () => {
    const fixture = loadFixture(platform);
    const { unmatched } = serveRecorded(fixture.responses);

    const items = await build().fetch(opts);
    const stripped = items.map(stripCreatedAt);

    if (RECORD) {
      writeFileSync(fixturePath(platform), `${JSON.stringify({ ...fixture, expected: stripped }, null, 2)}\n`);
      // A recording run must never be a green run: re-run without GOLDEN_RECORD.
      throw new Error(`recorded ${stripped.length} item(s) for ${platform}; re-run without GOLDEN_RECORD to verify`);
    }

    // Every request the fetcher made was one the fixture anticipated. An
    // unanticipated one would have been served nothing, and for the fetchers
    // that swallow lookup failures that shows up as a smaller item, not an error.
    expect(unmatched).toEqual([]);
    expect(stripped).toEqual(fixture.expected);
  });

  it('the fixture is not empty', () => {
    // The positive control. An empty `expected` would make toEqual pass
    // vacuously on a fetcher that returned nothing at all.
    expect(loadFixture(platform).expected.length).toBeGreaterThan(0);
  });
});
