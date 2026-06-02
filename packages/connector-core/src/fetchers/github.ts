import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem } from '../types/fetcher.js';

interface GitHubSearchItem {
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  repository_url?: string;
  user?: { login: string; html_url: string };
}

/**
 * Read-only personal GitHub fetcher: the caller's merged PRs and issues they
 * commented on. Author = the PR/issue user ("who to talk to").
 */
export class GitHubFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    const headers = {
      Authorization: `Bearer ${opts.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    const userRes = await fetch('https://api.github.com/user', { headers });
    if (!userRes.ok) {
      throw new Error(`GitHub auth failed (${userRes.status}). Check your token has 'repo' scope.`);
    }
    const user = (await userRes.json()) as { login: string };

    const limit = opts.limit ?? 100;
    const items: FetcherItem[] = [];

    const prRes = await fetch(
      `https://api.github.com/search/issues?q=author:${user.login}+type:pr+is:merged&sort=updated&per_page=${Math.min(limit, 50)}`,
      { headers },
    );
    if (prRes.ok) {
      const data = (await prRes.json()) as { items: GitHubSearchItem[] };
      for (const pr of data.items) {
        const repo = (pr.repository_url ?? '').replace('https://api.github.com/repos/', '');
        items.push({
          source_url: pr.html_url,
          platform: 'github',
          raw_text: `${pr.title}\n\n${pr.body ?? ''}\n\nStatus: ${pr.state}\nRepo: ${repo}`.trim(),
          title: pr.title,
          ...(pr.user ? { author: { name: pr.user.login, handle: pr.user.login, url: pr.user.html_url } } : {}),
        });
      }
    }

    if (items.length < limit) {
      const remaining = Math.min(limit - items.length, 50);
      const issueRes = await fetch(
        `https://api.github.com/search/issues?q=commenter:${user.login}+type:issue&sort=updated&per_page=${remaining}`,
        { headers },
      );
      if (issueRes.ok) {
        const data = (await issueRes.json()) as { items: GitHubSearchItem[] };
        for (const issue of data.items) {
          items.push({
            source_url: issue.html_url,
            platform: 'github',
            raw_text: `${issue.title}\n\n${issue.body ?? ''}\n\nStatus: ${issue.state}`.trim(),
            title: issue.title,
            ...(issue.user ? { author: { name: issue.user.login, handle: issue.user.login, url: issue.user.html_url } } : {}),
          });
        }
      }
    }

    return items.slice(0, limit);
  }
}
