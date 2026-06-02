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

// GitHub's Search API returns at most 100 results/page and 1000 total (10 pages).
const GH_PER_PAGE_MAX = 100;
const GH_SEARCH_MAX_PAGES = 10;

/** Page through a GitHub search query until `target` items are collected (or the
 *  results run out / the 1000-result ceiling is hit). */
async function searchAll(query: string, headers: Record<string, string>, target: number): Promise<GitHubSearchItem[]> {
  const out: GitHubSearchItem[] = [];
  for (let page = 1; out.length < target && page <= GH_SEARCH_MAX_PAGES; page++) {
    const perPage = Math.min(target - out.length, GH_PER_PAGE_MAX);
    const res = await fetch(`${query}&sort=updated&per_page=${perPage}&page=${page}`, { headers });
    if (!res.ok) break;
    const data = (await res.json()) as { items?: GitHubSearchItem[] };
    const batch = data.items ?? [];
    out.push(...batch);
    if (batch.length < perPage) break; // last page
  }
  return out.slice(0, target);
}

/**
 * Read-only personal GitHub fetcher: the caller's merged PRs and issues they
 * commented on. Author = the PR/issue user ("who to talk to"). Paginates up to
 * `limit` across both searches.
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

    const prs = await searchAll(
      `https://api.github.com/search/issues?q=author:${user.login}+type:pr+is:merged`,
      headers,
      limit,
    );
    for (const pr of prs) {
      const repo = (pr.repository_url ?? '').replace('https://api.github.com/repos/', '');
      items.push({
        source_url: pr.html_url,
        platform: 'github',
        raw_text: `${pr.title}\n\n${pr.body ?? ''}\n\nStatus: ${pr.state}\nRepo: ${repo}`.trim(),
        title: pr.title,
        ...(pr.user ? { author: { name: pr.user.login, handle: pr.user.login, url: pr.user.html_url } } : {}),
      });
    }

    if (items.length < limit) {
      const issues = await searchAll(
        `https://api.github.com/search/issues?q=commenter:${user.login}+type:issue`,
        headers,
        limit - items.length,
      );
      for (const issue of issues) {
        items.push({
          source_url: issue.html_url,
          platform: 'github',
          raw_text: `${issue.title}\n\n${issue.body ?? ''}\n\nStatus: ${issue.state}`.trim(),
          title: issue.title,
          ...(issue.user ? { author: { name: issue.user.login, handle: issue.user.login, url: issue.user.html_url } } : {}),
        });
      }
    }

    return items.slice(0, limit);
  }
}
