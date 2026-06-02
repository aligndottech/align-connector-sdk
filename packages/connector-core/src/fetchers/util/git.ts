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

/**
 * Build a web URL for a commit from the origin remote URL (GitHub/GitLab,
 * ssh/https/git protocols). Uses linear string ops (indexOf + anchored strips)
 * rather than backtracking regexes to stay ReDoS-safe on untrusted input.
 */
export function buildCommitUrl(remoteUrl: string | null | undefined, sha: string): string {
  if (!remoteUrl) return `git://commit/${sha}`;

  // Path = everything after "<host>", minus the leading separator and any
  // trailing ".git". Both replaces are anchored (^ / $) so they run in linear time.
  const pathAfter = (host: string): string | null => {
    const idx = remoteUrl.indexOf(host);
    if (idx < 0) return null;
    const rest = remoteUrl
      .slice(idx + host.length)
      .replace(/^[:/]+/, '')
      .replace(/\.git$/, '');
    return rest || null;
  };

  const gh = pathAfter('github.com');
  if (gh) return `https://github.com/${gh}/commit/${sha}`;
  const gl = pathAfter('gitlab.com');
  if (gl) return `https://gitlab.com/${gl}/-/commit/${sha}`;
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
