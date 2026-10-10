/**
 * fetchOne takes a URL from a person or an agent and sends a STORED credential. The
 * credential must never reach a host taken from that URL text. For every connector:
 * hostile URL forms make zero requests and return `shape`; a redirect is not followed;
 * an oversized body is refused; a valid vendor URL still works.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { GitHubFetcher } from '../fetchers/github.js';
import { GitLabFetcher } from '../fetchers/gitlab.js';
import { JiraFetcher } from '../fetchers/jira.js';
import { LinearFetcher } from '../fetchers/linear.js';
import { FETCH_ONE_MAX_BODY_BYTES } from '../fetchers/util/single.js';
import type { FetchOneOptions, FetchOneResult } from '../types/fetcher.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const TOKEN = 'secret-token-value-123';

function respond(status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: async () => JSON.parse(text),
    text: async () => text,
  } as unknown as Awaited<ReturnType<typeof fetch>>;
}

interface Case {
  name: string;
  run: (url: string) => Promise<FetchOneResult>;
  valid: string;
  validBody: unknown;
  hostile: string[];
}

const ghIssue = {
  html_url: 'https://github.com/o/r/issues/7',
  number: 7,
  title: 'T',
  body: 'b',
  state: 'open',
  repository_url: 'https://api.github.com/repos/o/r',
};

const common = (host: string, path: string) => [
  `https://${host}@evil.com${path}`, // userinfo: the real host is evil.com
  `https://evil.com@${host}${path}`, // userinfo on the right host: still refused
  `https://user:pw@${host}${path}`,
  `http://${host}${path}`, // not https
  `https://${host}:8443${path}`, // a port
  `https://${host}.evil.com${path}`, // lookalike suffix
  `https://evil.com/${host}${path}`, // host text in the path
  `https://${host}.${path}`, // trailing-dot host: the fully qualified spelling is still not the configured host
  `https://${host}\\@evil.com${path}`, // backslash trick
  ` https://${host}${path}`, // whitespace trick
  `https://${host}${path} `,
  `https://127.0.0.1${path}`, // IP literal
  `https://[::1]${path}`,
];

const CASES: Case[] = [
  {
    name: 'github',
    run: (url) => new GitHubFetcher().fetchOne(url, { token: TOKEN }),
    valid: 'https://github.com/o/r/issues/7',
    validBody: ghIssue,
    hostile: [...common('github.com', '/o/r/issues/7'), 'https://gist.github.com/o/r/issues/7', 'https://github.com.evil.com/o/r/issues/7'],
  },
  {
    name: 'gitlab',
    run: (url) => new GitLabFetcher().fetchOne(url, { token: TOKEN }),
    valid: 'https://gitlab.com/g/p/-/merge_requests/3',
    validBody: { web_url: 'https://gitlab.com/g/p/-/merge_requests/3', title: 'T', description: null, state: 'merged' },
    hostile: [...common('gitlab.com', '/g/p/-/merge_requests/3'), 'https://gitlab.example.com/g/p/-/merge_requests/3'],
  },
  {
    name: 'jira',
    run: (url) => new JiraFetcher().fetchOne(url, { token: TOKEN, cloudId: 'cid', siteBase: 'https://acme.atlassian.net' } as FetchOneOptions),
    valid: 'https://acme.atlassian.net/browse/ALI-1',
    validBody: { key: 'ALI-1', fields: { summary: 'S' } },
    hostile: [
      ...common('acme.atlassian.net', '/browse/ALI-1'),
      'https://evil.com/.atlassian.net/browse/ALI-1',
      'https://atlassian.net.evil.com/browse/ALI-1',
      'https://other.atlassian.net/browse/ALI-1', // a site this credential was not issued for
    ],
  },
  {
    name: 'linear',
    run: (url) => new LinearFetcher().fetchOne(url, { token: TOKEN }),
    valid: 'https://linear.app/acme/issue/ENG-1',
    validBody: { data: { issue: { id: 'i', title: 'T', description: null, url: 'https://linear.app/acme/issue/ENG-1/t' } } },
    hostile: [...common('linear.app', '/acme/issue/ENG-1'), 'https://linear.app.evil.com/acme/issue/ENG-1'],
  },
];

describe.each(CASES)('$name fetchOne credential safety', ({ run, valid, validBody, hostile }) => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it.each(hostile)('%j makes no request and is a shape skip', async (url) => {
    mockFetch.mockResolvedValue(respond(200, validBody));
    const out = await run(url);
    expect(mockFetch).toHaveBeenCalledTimes(0);
    expect(out).toEqual({ skip: { kind: 'shape', count: 1, detail: expect.any(String) } });
  });

  it('a valid vendor URL still works, on the vendor API host, without following redirects', async () => {
    mockFetch.mockResolvedValue(respond(200, validBody));
    const out = await run(valid);
    expect(out.item).toBeDefined();
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0); // positive control for the zero-call assertions
    for (const [input, init] of mockFetch.mock.calls) {
      expect(new URL(String(input)).hostname).toMatch(/^(api\.github\.com|gitlab\.com|api\.atlassian\.com|api\.linear\.app)$/);
      expect((init as { redirect?: string }).redirect).toBe('manual');
    }
  });

  it('a redirect is not followed: one request, an error skip, and the credential is not in it', async () => {
    mockFetch.mockResolvedValue(respond(302, '', { location: 'https://evil.com/steal' }));
    const out = await run(valid);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(out.item).toBeUndefined();
    expect(out.skip).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('an oversized body is refused as an error skip, never parsed', async () => {
    mockFetch.mockResolvedValue(respond(200, 'x'.repeat(FETCH_ONE_MAX_BODY_BYTES + 1)));
    const out = await run(valid);
    expect(out).toEqual({ skip: { kind: 'error', count: 1, detail: expect.stringContaining('too large') } });
  });

  it('a thrown network error never throws and never carries the credential', async () => {
    mockFetch.mockRejectedValue(new Error(`connect failed Authorization: Bearer ${TOKEN}`));
    const out = await run(valid);
    expect(out.skip).toMatchObject({ kind: 'error' });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });
});
