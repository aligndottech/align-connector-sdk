import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchResult } from '../types/fetcher.js';
import { buildCommitUrl, formatCommitAsText, type GitCommit } from './util/git.js';
import { toIsoOrUndefined } from './util/time.js';
import { buildFetchReport } from './util/report.js';

export type { GitCommit } from './util/git.js';

/** A commit read plus what the RAW scan (before any filter) saw. */
export interface GitCommitHistory {
  /** The commits kept after any filter the source applies. */
  commits: GitCommit[];
  /** Raw commits the scan examined before any filter. */
  scanned: number;
  /** True only when the raw scan ended before its limit: there were no older commits. */
  exhausted: boolean;
}

/**
 * The git I/O the {@link GitFetcher} needs, injected by the caller (e.g. the CLI
 * wraps `git log` / `git remote` via execa). Keeps connector-core process-free.
 */
export interface GitCommitSource {
  /**
   * Either the commits alone (the original contract), or the commits plus what the raw
   * scan saw. Return the second form: a source that filters after `git log -n limit`
   * keeps far fewer commits than it scanned, so only the source can say whether history
   * ran out. A bare array is read as "cannot say", and the report is not complete.
   */
  getCommitHistory(opts: { limit: number }): Promise<GitCommit[] | GitCommitHistory>;
  getRemoteUrl(): Promise<string | null | undefined>;
}

/**
 * Read-only local-git fetcher: maps decision-relevant commits to FetcherItems.
 * Author = the commit author ("who to talk to"). `token` is unused (local).
 */
export class GitFetcher implements ConnectorFetcher {
  constructor(private readonly source: GitCommitSource) {}

  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
    const limit = opts.limit ?? 100;
    const history = await this.source.getCommitHistory({ limit });
    const { commits, scanned, exhausted } = Array.isArray(history)
      ? { commits: history, scanned: history.length, exhausted: false }
      : history;
    const remoteUrl = await this.source.getRemoteUrl();
    const items = commits.map((c) => {
      const url = buildCommitUrl(remoteUrl, c.sha);
      const createdAt = toIsoOrUndefined(c.date);
      return {
        source_url: url,
        platform: 'git',
        raw_text: formatCommitAsText(c, url),
        title: c.subject,
        ...(createdAt ? { created_at: createdAt } : {}),
        ...(c.author ? { author: { name: c.author } } : {}),
      } satisfies FetcherItem;
    });
    // Only the source knows whether its raw scan was cut: a filtered list shorter than
    // `limit` is normal and proves nothing. Scope is 'team': history holds every author.
    return {
      items,
      report: buildFetchReport(items, {
        platform: 'git',
        scanned,
        requested: limit,
        skips: [],
        scope: 'team',
        exhausted,
      }),
    };
  }
}
