/**
 * normaliseSourceKey is driven by the PUBLISHED fixture table, so the CLI and the
 * gateway can run the same rows against their own readers and cannot disagree
 * about what one item's key is.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FETCHERS, SYNTHETIC_SOURCE_PREFIXES, normaliseSourceKey } from '../index.js';

interface KeyCase {
  platform: string;
  rule: string;
  a: string;
  b?: string;
  same?: boolean;
  key: string | null;
  why: string;
}

const PKG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TABLE = JSON.parse(
  readFileSync(join(PKG_DIR, 'src', '__fixtures__', 'source-key-fixtures.json'), 'utf8'),
) as { rules: Record<string, string>; cases: KeyCase[] };

// Every platform the SDK fetches: the registry plus git, which needs an injected source.
const PLATFORMS = [...Object.keys(FETCHERS), 'git'];
const BASE_RULES = ['host_case', 'trailing_slash', 'fragment', 'query'];
const SLUG_PLATFORMS = ['linear', 'confluence', 'notion'];

describe('source-key fixture table', () => {
  it('covers every fetched platform and every rule on both sides', () => {
    expect(PLATFORMS).toHaveLength(10); // positive control: the registry was read
    const missing: string[] = [];
    const want = [
      ...PLATFORMS.flatMap((p) => BASE_RULES.map((r) => [p, r] as const)),
      ...SLUG_PLATFORMS.map((p) => [p, 'slug'] as const),
      ['confluence', 'page_id'] as const,
      ['slack', 'workspace_host'] as const,
      ['github', 'github_owner_case'] as const,
      ['git', 'github_owner_case'] as const,
      ['teams', 'percent_case'] as const,
      ['zoom', 'percent_case'] as const,
      ['notion', 'notion_peek'] as const,
      ['github', 'comment_anchor'] as const,
      ['jira', 'comment_anchor'] as const,
      ['linear', 'comment_anchor'] as const,
    ];
    for (const [platform, rule] of want) {
      for (const same of [true, false]) {
        const n = TABLE.cases.filter((c) => c.platform === platform && c.rule === rule && c.same === same).length;
        if (n === 0) missing.push(`${platform}/${rule}/${same ? 'same' : 'different'}`);
      }
    }
    expect(missing).toEqual([]);
    for (const c of TABLE.cases) expect(Object.keys(TABLE.rules)).toContain(c.rule);
    // The no-key rows cover the Teams fallback and every synthetic prefix, member by member.
    const noKey = TABLE.cases.filter((c) => c.rule === 'no_key').map((c) => c.a);
    expect(noKey).toContain('https://teams.microsoft.com');
    expect(noKey).toContain('https://teams.microsoft.com/?tenantId=t1');
    for (const product of ['jira', 'confluence']) {
      expect(noKey.some((a) => a.startsWith(`https://api.atlassian.com/ex/${product}/`))).toBe(true);
    }
    for (const prefix of SYNTHETIC_SOURCE_PREFIXES) expect(noKey.some((a) => a.startsWith(prefix))).toBe(true);
  });

  const keyed = TABLE.cases.filter((c) => c.rule !== 'no_key');
  it.each(keyed)('$platform $rule: $why', (c) => {
    const ka = normaliseSourceKey(c.platform, c.a);
    const kb = normaliseSourceKey(c.platform, c.b!);
    expect(ka).toBe(c.key);
    expect(typeof c.same).toBe('boolean');
    expect(ka === kb).toBe(c.same);
  });

  it.each(TABLE.cases.filter((c) => c.rule === 'no_key'))('$platform no key: $why', (c) => {
    expect(c.key).toBeNull();
    expect(normaliseSourceKey(c.platform, c.a)).toBeUndefined();
  });
});

describe('normaliseSourceKey', () => {
  it('gives one key for a PR URL differing by host case, trailing slash and fragment', () => {
    expect(normaliseSourceKey('github', 'https://GitHub.com/o/r/pull/12/')).toBe(
      normaliseSourceKey('github', 'https://github.com/o/r/pull/12#discussion_r1'),
    );
  });

  it('keeps a PR and an issue with the same number apart', () => {
    expect(normaliseSourceKey('github', 'https://github.com/o/r/pull/12')).not.toBe(
      normaliseSourceKey('github', 'https://github.com/o/r/issues/12'),
    );
  });

  it('keys a Confluence pageId URL by page id, and drops a GitHub query', () => {
    expect(normaliseSourceKey('confluence', 'https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=123')).toBe(
      'https://acme.atlassian.net/wiki/pages/123',
    );
    // A Confluence URL in neither page form still keeps pageId, the only id it carries.
    expect(normaliseSourceKey('confluence', 'https://acme.atlassian.net/wiki/plugins/diff?pageId=5&x=1')).toBe(
      'https://acme.atlassian.net/wiki/plugins/diff?pageId=5',
    );
    expect(normaliseSourceKey('github', 'https://github.com/o/r/pull/12?w=1')).toBe('https://github.com/o/r/pull/12');
  });

  it('does not apply one platform allowlist to another platform', () => {
    expect(normaliseSourceKey('github', 'https://github.com/o/r/pull/12?thread_ts=1')).toBe('https://github.com/o/r/pull/12');
    expect(normaliseSourceKey('slack', 'https://acme.slack.com/archives/C1/p1?pageId=1')).toBe('https://slack.com/archives/C1/p1');
  });

  it('keeps allowlisted parameters in name order, so parameter order cannot split a key', () => {
    // A synthetic second allowlisted name is not available, so order is pinned through
    // repeated values of the one name, which URLSearchParams would otherwise keep in input order.
    expect(normaliseSourceKey('slack', 'https://a.slack.com/archives/C1/p1?thread_ts=2&thread_ts=1')).toBe(
      normaliseSourceKey('slack', 'https://a.slack.com/archives/C1/p1?thread_ts=1&thread_ts=2'),
    );
  });

  it('drops userinfo, so a credential never becomes part of a key', () => {
    expect(normaliseSourceKey('github', 'https://user:secret@github.com/o/r/pull/12')).toBe('https://github.com/o/r/pull/12');
  });

  it('gives no key for an unparseable input rather than inventing one', () => {
    expect(normaliseSourceKey('github', 'not a url')).toBeUndefined();
    expect(normaliseSourceKey('github', '')).toBeUndefined();
  });

  it('gives no key for the Teams fallback URL or any synthetic identity, and a key for a real Teams message', () => {
    expect(normaliseSourceKey('teams', 'https://teams.microsoft.com')).toBeUndefined();
    expect(normaliseSourceKey('github', 'align://claimed/9f2c')).toBeUndefined();
    expect(normaliseSourceKey('teams', 'https://teams.microsoft.com/l/message/CH1/m1')).toBe('https://teams.microsoft.com/l/message/CH1/m1');
  });

  it('leaves an unknown platform on the four generic rules', () => {
    expect(normaliseSourceKey('miro', 'HTTPS://Miro.com/app/board/x/?moveToWidget=1#y')).toBe('https://miro.com/app/board/x');
  });
});
