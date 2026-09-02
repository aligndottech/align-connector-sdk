import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchResult } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';

interface GitHubSearchItem {
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  /** When it was opened. Uniform across PRs and issues, unlike merged_at. */
  created_at?: string;
  number?: number;
  repository_url?: string;
  user?: { login: string; html_url: string };
  /** Present (possibly with merged_at: null) only when the item is a PR. */
  pull_request?: { merged_at: string | null };
}

interface DiscussionEntry {
  body: string | null;
  user?: { login: string };
  created_at?: string;
  submitted_at?: string;
  state?: string;
}

// GitHub's Search API returns at most 100 results/page and 1000 total (10 pages).
const GH_PER_PAGE_MAX = 100;
const GH_SEARCH_MAX_PAGES = 10;

// How many items may have their discussion (comments/reviews) in flight at
// once. Each item costs up to 3 extra requests (issue comments, PR reviews,
// PR review comments) - bounding this keeps a large personal history from
// blasting past GitHub's rate limit. Lower than the gateway's hosted scan
// (20, services/gateway/src/discover/githubHistorical.ts) because this runs
// unattended on a personal token with no retry/backoff around it.
const PARALLEL_DISCUSSION_FETCHES = 5;

// A single comment/review section is capped so one pathological thread (a
// bot dump, a copy-pasted log) can't blow the whole item's extraction budget.
const MAX_SECTION_CHARS = 4000;

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

/** Alternate between two ordered lists (PRs, issues) so neither can crowd the
 *  other out once the combined total is trimmed to `limit`. A plain
 *  concat-then-slice would let a prolific PR history exhaust the limit before
 *  a single issue is considered. */
function interleave<A, B>(a: A[], b: B[], limit: number): Array<{ kind: 'pr'; row: A } | { kind: 'issue'; row: B }> {
  const out: Array<{ kind: 'pr'; row: A } | { kind: 'issue'; row: B }> = [];
  let i = 0;
  let j = 0;
  while (out.length < limit && (i < a.length || j < b.length)) {
    if (i < a.length) out.push({ kind: 'pr', row: a[i++]! });
    if (out.length < limit && j < b.length) out.push({ kind: 'issue', row: b[j++]! });
  }
  return out;
}

/** Bounded-concurrency map that preserves input order in the output, so a
 *  fast item never jumps ahead of a slow one in the returned list. */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, () => worker()));
  return results;
}

function capSection(heading: string, entries: string[]): string {
  if (entries.length === 0) return '';
  let body = entries.join('\n\n');
  if (body.length > MAX_SECTION_CHARS) {
    body = `${body.slice(0, MAX_SECTION_CHARS)}\n[discussion truncated]`;
  }
  return `\n\n## ${heading}\n${body}`;
}

function formatEntries(entries: DiscussionEntry[], withState: boolean): string[] {
  return entries
    .filter((e) => e.body?.trim())
    .map((e) => {
      const who = e.user?.login ?? 'Unknown';
      const when = e.submitted_at ?? e.created_at ?? '';
      const state = withState && e.state ? ` [${e.state}]` : '';
      return `[${who}] (${when})${state}:\n${e.body}`;
    });
}

/** Fetch one discussion endpoint, tolerating a failed or throwing request so
 *  one bad section never drops an otherwise-good item (ALI-805: the argument
 *  is a bonus on top of the announcement, not a requirement for it). */
async function fetchSection(
  url: string,
  headers: Record<string, string>,
  heading: string,
  withState: boolean,
): Promise<string> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return '';
    const entries = (await res.json()) as DiscussionEntry[];
    return capSection(heading, formatEntries(entries, withState));
  } catch {
    return '';
  }
}

function repoOf(item: GitHubSearchItem): string {
  return (item.repository_url ?? '').replace('https://api.github.com/repos/', '');
}

async function buildPrItem(pr: GitHubSearchItem, headers: Record<string, string>): Promise<FetcherItem> {
  const repo = repoOf(pr);
  const status = pr.pull_request?.merged_at ? 'merged' : pr.state;
  let rawText = `${pr.title}\n\n${pr.body ?? ''}\n\nStatus: ${status}\nRepo: ${repo}`.trim();

  if (repo && pr.number != null) {
    // Sequential, not Promise.all: GitHub's own best-practices guidance is
    // to make requests serially rather than concurrently to avoid secondary
    // rate limiting. PARALLEL_DISCUSSION_FETCHES already bounds how many
    // ITEMS run at once - firing 3 more requests concurrently per item would
    // undo that bound (5 items x 3 requests = 15 requests in flight).
    rawText += await fetchSection(`https://api.github.com/repos/${repo}/issues/${pr.number}/comments?per_page=20`, headers, 'Comments', false);
    rawText += await fetchSection(`https://api.github.com/repos/${repo}/pulls/${pr.number}/reviews?per_page=20`, headers, 'Code Reviews', true);
    rawText += await fetchSection(`https://api.github.com/repos/${repo}/pulls/${pr.number}/comments?per_page=20`, headers, 'Review Comments', false);
  }

  const createdAt = toIsoOrUndefined(pr.created_at);
  return {
    source_url: pr.html_url,
    platform: 'github',
    raw_text: rawText,
    title: pr.title,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(pr.user ? { author: { name: pr.user.login, handle: pr.user.login, url: pr.user.html_url } } : {}),
  };
}

async function buildIssueItem(issue: GitHubSearchItem, headers: Record<string, string>): Promise<FetcherItem> {
  const repo = repoOf(issue);
  let rawText = `${issue.title}\n\n${issue.body ?? ''}\n\nStatus: ${issue.state}`.trim();

  if (repo && issue.number != null) {
    rawText += await fetchSection(
      `https://api.github.com/repos/${repo}/issues/${issue.number}/comments?per_page=20`,
      headers,
      'Comments',
      false,
    );
  }

  const createdAt = toIsoOrUndefined(issue.created_at);
  return {
    source_url: issue.html_url,
    platform: 'github',
    raw_text: rawText,
    title: issue.title,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(issue.user ? { author: { name: issue.user.login, handle: issue.user.login, url: issue.user.html_url } } : {}),
  };
}

/**
 * Read-only personal GitHub fetcher.
 *
 * ALI-805: the old two queries (`author:+is:merged`, `commenter:`) missed
 * self-filed issues (`commenter:` never matches the original post), every
 * open or reverted PR (`is:merged` drops both - and a reversal is one of the
 * most decision-dense things in a repo), and anything only assigned or
 * mentioned. `involves:` is GitHub's own union of author/assignee/mentions/
 * commenter, so it replaces both narrow queries - but it does NOT cover code
 * review (confirmed against GitHub's search-qualifiers docs), so a PR the
 * user only reviewed needs its own `reviewed-by:` query.
 *
 * And per item, this now fetches the discussion - issue/PR comments, PR
 * review bodies, and inline review comments - not just the title and body.
 * That is where the "why" usually lives: the body says what changed, the
 * thread is where someone objects and the author agrees or pushes back.
 */
export class GitHubFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
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

    const [involvesPrs, reviewedPrs, issues] = await Promise.all([
      searchAll(`https://api.github.com/search/issues?q=involves:${user.login}+type:pr`, headers, limit),
      searchAll(`https://api.github.com/search/issues?q=reviewed-by:${user.login}+type:pr`, headers, limit),
      searchAll(`https://api.github.com/search/issues?q=involves:${user.login}+type:issue`, headers, limit),
    ]);

    // involves: and reviewed-by: can both return the same PR (e.g. you
    // authored it AND someone else reviewed you on it too) - dedupe before
    // the item ever reaches the discussion-fetch stage.
    const prByUrl = new Map<string, GitHubSearchItem>();
    for (const pr of [...involvesPrs, ...reviewedPrs]) prByUrl.set(pr.html_url, pr);

    const rows = interleave([...prByUrl.values()], issues, limit);

    const items = await mapWithConcurrency(rows, PARALLEL_DISCUSSION_FETCHES, (r) =>
      r.kind === 'pr' ? buildPrItem(r.row, headers) : buildIssueItem(r.row, headers),
    );
    return { items, report: { platform: 'github', scanned: rows.length, requested: limit, skips: [] } };
  }
}
