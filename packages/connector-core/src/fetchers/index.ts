import type { ConnectorFetcher } from '../types/fetcher.js';
import { GitHubFetcher } from './github.js';
import { GitLabFetcher } from './gitlab.js';
import { JiraFetcher } from './jira.js';
import { ConfluenceFetcher } from './confluence.js';
import { SlackFetcher } from './slack.js';
import { TeamsFetcher } from './teams.js';
import { ZoomFetcher } from './zoom.js';
import { LinearFetcher } from './linear.js';
import { NotionFetcher } from './notion.js';

export { GitHubFetcher } from './github.js';
export { GitLabFetcher } from './gitlab.js';
export { JiraFetcher } from './jira.js';
export { ConfluenceFetcher } from './confluence.js';
export { SlackFetcher } from './slack.js';
export { TeamsFetcher } from './teams.js';
export { ZoomFetcher } from './zoom.js';
export { LinearFetcher } from './linear.js';
export { NotionFetcher } from './notion.js';
export { GitFetcher, type GitCommitSource, type GitCommit } from './git.js';
export { buildCommitUrl, formatCommitAsText } from './util/git.js';
export { FetcherAuthError } from './errors.js';

/**
 * Registry of token-based read-only fetchers, keyed by platform. The CLI and the
 * gateway discover scan both resolve fetchers from here. `git` is not registered
 * because it needs an injected {@link GitCommitSource} (local process I/O).
 */
export const FETCHERS: Record<string, () => ConnectorFetcher> = {
  github: () => new GitHubFetcher(),
  gitlab: () => new GitLabFetcher(),
  jira: () => new JiraFetcher(),
  confluence: () => new ConfluenceFetcher(),
  slack: () => new SlackFetcher(),
  teams: () => new TeamsFetcher(),
  zoom: () => new ZoomFetcher(),
  linear: () => new LinearFetcher(),
  notion: () => new NotionFetcher(),
};
