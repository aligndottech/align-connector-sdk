import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem } from '../types/fetcher.js';
import { buildCommitUrl, formatCommitAsText, type GitCommit } from './util/git.js';

export type { GitCommit } from './util/git.js';

/**
 * The git I/O the {@link GitFetcher} needs, injected by the caller (e.g. the CLI
 * wraps `git log` / `git remote` via execa). Keeps connector-core process-free.
 */
export interface GitCommitSource {
  getCommitHistory(opts: { limit: number }): Promise<GitCommit[]>;
  getRemoteUrl(): Promise<string | null | undefined>;
}

/**
 * Read-only local-git fetcher: maps decision-relevant commits to FetcherItems.
 * Author = the commit author ("who to talk to"). `token` is unused (local).
 */
export class GitFetcher implements ConnectorFetcher {
  constructor(private readonly source: GitCommitSource) {}

  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    const limit = opts.limit ?? 100;
    const commits = await this.source.getCommitHistory({ limit });
    const remoteUrl = await this.source.getRemoteUrl();
    return commits.map((c) => {
      const url = buildCommitUrl(remoteUrl, c.sha);
      return {
        source_url: url,
        platform: 'git',
        raw_text: formatCommitAsText(c, url),
        title: c.subject,
        ...(c.author ? { author: { name: c.author } } : {}),
      } satisfies FetcherItem;
    });
  }
}
