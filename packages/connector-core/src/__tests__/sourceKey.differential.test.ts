/**
 * The zoom meeting_id change must move ONLY the URLs it is about. Both functions run over a
 * few thousand generated URLs (seeded, so the run is reproducible); every disagreement must
 * involve a zoom meeting_id query or the zoom chat URL, and every such URL must disagree
 * in the direction the fix intends.
 */
import { describe, expect, it } from 'vitest';
import { normaliseSourceKey } from '../sourceKey.js';
import { normaliseSourceKey as previous } from './helpers/sourceKeyPrev.js';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const PLATFORMS = ['github', 'git', 'gitlab', 'jira', 'confluence', 'linear', 'notion', 'slack', 'teams', 'zoom', 'miro'];
const HOSTS = ['github.com', 'acme.atlassian.net', 'linear.app', 'www.notion.so', 'a.slack.com', 'teams.microsoft.com', 'zoom.us', 'ZOOM.US', 'example.com'];
const PATHS = ['/', '/o/r/pull/1', '/wiki/pages/123', '/wiki/pages/viewpage.action', '/archives/C1/p1', '/recording/detail', '/recording/detail/', '/chat', '/l/message/CH1/m1', '/browse/ALI-1', '/x/y'];
const PARAMS = ['pageId=1', 'thread_ts=2', 'meeting_id=abc', 'meeting_id=ABC', 'meeting_id=a%2Fb', 'w=1', 'focusedCommentId=9', 'p=0123456789abcdef0123456789abcdef'];
const FRAGS = ['', '', '#c1'];

function generate(n: number): Array<[string, string]> {
  const r = rng(20261010);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const out: Array<[string, string]> = [];
  for (let i = 0; i < n; i++) {
    const params = Array.from({ length: Math.floor(r() * 4) }, () => pick(PARAMS));
    const q = params.length ? `?${params.join('&')}` : '';
    out.push([pick(PLATFORMS), `https://${pick(HOSTS)}${pick(PATHS)}${q}${pick(FRAGS)}`]);
  }
  return out;
}

const involvesNewRule = (platform: string, url: string): boolean => {
  if (platform !== 'zoom') return false;
  const u = new URL(url);
  return u.searchParams.has('meeting_id') || u.pathname.replace(/\/+$/, '') === '/chat';
};

describe('normaliseSourceKey vs the 0.10.0 function', () => {
  const urls = generate(4000);
  const diffs = urls.filter(([p, u]) => normaliseSourceKey(p, u) !== previous(p, u));

  it('moves only zoom meeting_id and zoom chat URLs', () => {
    expect(urls).toHaveLength(4000);
    // positive control: the generator reaches the new rule, so an empty diff cannot pass
    expect(urls.filter(([p, u]) => involvesNewRule(p, u)).length).toBeGreaterThan(20);
    expect(diffs.filter(([p, u]) => !involvesNewRule(p, u))).toEqual([]);
  });

  it('every zoom meeting_id URL on a recording path now keeps its meeting, and every chat URL loses its key', () => {
    for (const [p, u] of urls.filter(([p2, u2]) => involvesNewRule(p2, u2))) {
      const now = normaliseSourceKey(p, u);
      const url = new URL(u);
      if (url.pathname.replace(/\/+$/, '') === '/chat') {
        expect(now).toBeUndefined();
      } else if (url.pathname.replace(/\/+$/, '') === '') {
        expect(now).toBeUndefined(); // a bare host stays keyless
        expect(previous(p, u)).toBeUndefined();
      } else {
        expect(now).toContain('meeting_id=');
        expect(now).not.toBe(previous(p, u));
      }
    }
  });
});
