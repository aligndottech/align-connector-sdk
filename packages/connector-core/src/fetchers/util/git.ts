/**
 * Pure git helpers (no process I/O) used by the GitFetcher. The actual
 * `git log` / `git remote` calls are injected via {@link GitCommitSource} so
 * connector-core stays free of execa/child_process.
 */

export interface GitCommit {
  sha: string;
  subject: string;
  body?: string;
  author?: string;
  date?: string;
  filesChanged?: string[];
}

/** Build a web URL for a commit from the origin remote URL (GitHub/GitLab/ssh/https). */
export function buildCommitUrl(remoteUrl: string | null | undefined, sha: string): string {
  if (!remoteUrl) return `git://commit/${sha}`;
  const sshGh = remoteUrl.match(/git@github\.com[:/](.+?)(?:\.git)?$/);
  if (sshGh) return `https://github.com/${sshGh[1]}/commit/${sha}`;
  const httpsGh = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/);
  if (httpsGh) return `https://github.com/${httpsGh[1]}/commit/${sha}`;
  const gl = remoteUrl.match(/gitlab\.com[:/](.+?)(?:\.git)?$/);
  if (gl) return `https://gitlab.com/${gl[1]}/-/commit/${sha}`;
  return `git://commit/${sha}`;
}

/** Render a commit as the raw text we ingest. */
export function formatCommitAsText(commit: GitCommit, commitUrl?: string): string {
  const parts = [commit.subject];
  if (commit.body) parts.push(commit.body);
  if (commit.author) parts.push(`Author: ${commit.author}`);
  if (commit.date) parts.push(`Date: ${commit.date}`);
  if (commit.filesChanged?.length) {
    parts.push(`Files changed:\n${commit.filesChanged.join('\n')}`);
  }
  if (commitUrl) parts.push(`URL: ${commitUrl}`);
  return parts.join('\n\n');
}
