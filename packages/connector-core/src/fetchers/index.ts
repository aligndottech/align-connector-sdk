import type { ConnectorFetcher } from '../types/fetcher.js';
import { GitHubFetcher } from './github.js';
import { GitLabFetcher } from './gitlab.js';

export { GitHubFetcher } from './github.js';
export { GitLabFetcher } from './gitlab.js';
export { GitFetcher, type GitCommitSource, type GitCommit } from './git.js';
export { buildCommitUrl, formatCommitAsText } from './util/git.js';

/**
 * Registry of token-based read-only fetchers, keyed by platform. The CLI and the
 * gateway discover scan both resolve fetchers from here. `git` is not registered
 * because it needs an injected {@link GitCommitSource} (local process I/O).
 */
export const FETCHERS: Record<string, () => ConnectorFetcher> = {
  github: () => new GitHubFetcher(),
  gitlab: () => new GitLabFetcher(),
};
