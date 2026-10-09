import { describe, expect, it } from 'vitest';
import { GitFetcher, type GitCommitSource } from '../fetchers/git.js';
import { buildCommitUrl, formatCommitAsText } from '../fetchers/util/git.js';

describe('GitFetcher', () => {
  const source: GitCommitSource = {
    async getCommitHistory() {
      return [
        { sha: 'abc123', subject: 'Adopt hexagonal architecture', author: 'Ada', date: '2026-01-01', body: 'why', filesChanged: ['a.ts'] },
      ];
    },
    async getRemoteUrl() {
      return 'git@github.com:org/repo.git';
    },
  };

  it('maps commits to FetcherItems with a web URL and author = commit author', async () => {
    const items = await new GitFetcher(source).fetch({ token: 'unused', limit: 50 });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      source_url: 'https://github.com/org/repo/commit/abc123',
      platform: 'git',
      title: 'Adopt hexagonal architecture',
      author: { name: 'Ada' },
    });
    expect(items[0].raw_text).toContain('Author: Ada');
  });

  it('omits author when the commit has none', async () => {
    const noAuthor: GitCommitSource = {
      getCommitHistory: async () => [{ sha: 'd', subject: 's' }],
      getRemoteUrl: async () => null,
    };
    const items = await new GitFetcher(noAuthor).fetch({ token: '' });
    expect(items[0].author).toBeUndefined();
    expect(items[0].source_url).toBe('git://commit/d');
  });
});

describe('git url + text helpers', () => {
  it('builds GitHub/GitLab/ssh/https/none URLs', () => {
    expect(buildCommitUrl('git@github.com:o/r.git', 's')).toBe('https://github.com/o/r/commit/s');
    expect(buildCommitUrl('https://github.com/o/r.git', 's')).toBe('https://github.com/o/r/commit/s');
    expect(buildCommitUrl('https://gitlab.com/o/r.git', 's')).toBe('https://gitlab.com/o/r/-/commit/s');
    expect(buildCommitUrl(null, 's')).toBe('git://commit/s');
  });

  it('formats a commit, skipping absent fields', () => {
    expect(formatCommitAsText({ sha: 'x', subject: 'only subject' })).toBe('only subject');
    const full = formatCommitAsText({ sha: 'x', subject: 's', body: 'b', author: 'A', date: 'D', filesChanged: ['f'] }, 'http://u');
    expect(full).toContain('Author: A');
    expect(full).toContain('Files changed:\nf');
    expect(full).toContain('URL: http://u');
  });
});

describe('GitFetcher completeness (a false complete:true lets a sync watermark skip commits forever)', () => {
  /**
   * Models align-cli's real writer, getCommitHistoryDetailed: `git log -n limit` scans
   * RAW commits, THEN the decision filters drop most of them. So a short kept list is
   * normal and says nothing about whether history ran out; only the raw scan can.
   */
  const realWriter = (rawInHistory: number, keepEvery = 2): GitCommitSource => ({
    async getCommitHistory({ limit }) {
      const scanned = Math.min(rawInHistory, limit);
      const commits = Array.from({ length: scanned }, (_, i) => ({ sha: `s${i}`, subject: `Adopt ${i}` })).filter(
        (_, i) => i % keepEvery === 0,
      );
      return { commits, scanned, exhausted: scanned < limit };
    },
    getRemoteUrl: async () => null,
  });

  it('is NOT complete when the raw scan hit its limit, even though fewer commits than the limit survived the filter', async () => {
    const { items, report } = await new GitFetcher(realWriter(40)).fetchWithReport({ token: '', limit: 10 });
    expect(items.length).toBeLessThan(10); // the old `commits.length < limit` test would say "exhausted"
    expect(report.scanned).toBe(10); // raw commits examined, not kept ones
    expect(report.complete).toBe(false);
  });

  it('is complete when the raw scan ended before its limit: the history ran out', async () => {
    const { items, report } = await new GitFetcher(realWriter(3)).fetchWithReport({ token: '', limit: 10 });
    expect(items).toHaveLength(2);
    expect(report.scanned).toBe(3);
    expect(report.complete).toBe(true);
  });

  it('is NOT complete when the source returns a bare array, because it cannot say whether its scan was cut', async () => {
    const legacy: GitCommitSource = { getCommitHistory: async () => [{ sha: 'a', subject: 'Adopt x' }], getRemoteUrl: async () => null };
    const { report } = await new GitFetcher(legacy).fetchWithReport({ token: '', limit: 50 });
    expect(report.scanned).toBe(1);
    expect(report.complete).toBe(false);
  });
});
