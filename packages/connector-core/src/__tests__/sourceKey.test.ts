/**
 * normaliseSourceKey is driven by the PUBLISHED fixture table, so the CLI and the
 * gateway can run the same rows against their own readers and cannot disagree
 * about what one item's key is.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FETCHERS, normaliseSourceKey } from '../index.js';

interface KeyCase {
  platform: string;
  rule: string;
  a: string;
  b: string;
  same: boolean;
  key: string;
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
    ];
    for (const [platform, rule] of want) {
      for (const same of [true, false]) {
        const n = TABLE.cases.filter((c) => c.platform === platform && c.rule === rule && c.same === same).length;
        if (n === 0) missing.push(`${platform}/${rule}/${same ? 'same' : 'different'}`);
      }
    }
    expect(missing).toEqual([]);
    for (const c of TABLE.cases) expect(Object.keys(TABLE.rules)).toContain(c.rule);
  });

  it.each(TABLE.cases)('$platform $rule: $why', (c) => {
    const ka = normaliseSourceKey(c.platform, c.a);
    const kb = normaliseSourceKey(c.platform, c.b);
    expect(ka).toBe(c.key);
    expect(ka === kb).toBe(c.same);
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

  it('keeps Confluence pageId and drops a GitHub query', () => {
    expect(normaliseSourceKey('confluence', 'https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=123')).toBe(
      'https://acme.atlassian.net/wiki/pages/viewpage.action?pageId=123',
    );
    expect(normaliseSourceKey('github', 'https://github.com/o/r/pull/12?w=1')).toBe('https://github.com/o/r/pull/12');
  });

  it('does not apply one platform allowlist to another platform', () => {
    expect(normaliseSourceKey('github', 'https://github.com/o/r/pull/12?thread_ts=1')).toBe('https://github.com/o/r/pull/12');
    expect(normaliseSourceKey('slack', 'https://acme.slack.com/archives/C1/p1?pageId=1')).toBe('https://acme.slack.com/archives/C1/p1');
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

  it('returns an unparseable input unchanged rather than inventing a key', () => {
    expect(normaliseSourceKey('github', 'not a url')).toBe('not a url');
    expect(normaliseSourceKey('github', '')).toBe('');
  });

  it('leaves an unknown platform on the four generic rules', () => {
    expect(normaliseSourceKey('miro', 'HTTPS://Miro.com/app/board/x/?moveToWidget=1#y')).toBe('https://miro.com/app/board/x');
  });
});
