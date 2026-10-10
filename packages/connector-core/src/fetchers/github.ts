import { fetch } from 'undici';
import type {
  ConnectorFetcher,
  ConnectorFetcherOptions,
  FetcherItem,
  FetchOneOptions,
  FetchOneResult,
  FetchResult,
  FetchSkip,
} from '../types/fetcher.js';
import { parseWindow, toIsoOrUndefined } from './util/time.js';
import { providerError } from './errors.js';
import { buildFetchReport, refusedRead } from './util/report.js';
import { normaliseSourceKey } from '../sourceKey.js';
import { type Clock, SlidingWindowLimiter, deadlineFrom, pastDeadline, realClock } from './util/pace.js';
import { FETCH_ONE_TIMEOUT_MS, fetchOneInit, readJsonCapped, shapeSkip, statusSkip, thrownSkip, tooLargeSkip, vendorUrl } from './util/single.js';
import {
  type DaySlice,
  type GitHubSearchItem,
  GH_SEARCHES_PER_MINUTE,
  monthSlices,
  newSearchContext,
  readSearch,
  searchSkips,
  updatedQualifier,
} from './githubSearch.js';

interface DiscussionEntry {
  body: string | null;
  user?: { login: string };
  created_at?: string;
  submitted_at?: string;
  state?: string;
}

/**
 * GitHub-specific read options. `repo` (ALI-917) narrows the caller's own searches to one
 * `owner/repo` and keeps `scope: 'yours'`; `scope: 'team'` WITH `repo` reads everyone's PRs
 * and issues in that repo. Team scope is opt-in rather than implied by `repo` because the
 * CLI already passes `repo` by default as a personal narrowing, and widening that silently
 * would import other people's items without the disclosure the consumer owes them.
 */
export interface GitHubFetcherOptions extends ConnectorFetcherOptions {
  /** 'full' (default): fetch each item's comments and reviews now. 'none': items only,
   *  each fetchable item marked `detail_pending`, for {@link fetchGitHubDiscussion} later. */
  discussion?: 'none' | 'full';
  /** 'team' takes effect only with `repo`; otherwise the read stays the caller's own. */
  scope?: 'yours' | 'team';
  /** Test seam for pacing and the time budget. */
  clock?: Clock;
}

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

const API = 'https://api.github.com';

/** `owner/repo`, nothing else: it is spliced into a search query. */
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function headersFor(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
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

/** One discussion endpoint. `ok` is false when it failed or threw: the list fetch
 *  tolerates that (ALI-805: the argument is a bonus on top of the announcement, not a
 *  requirement for it); the background drain does not, and leaves the item pending. */
async function fetchSection(
  url: string,
  headers: Record<string, string>,
  heading: string,
  withState: boolean,
  counter?: { requests: number },
  oneShot?: { signal: AbortSignal },
): Promise<{ text: string; ok: boolean }> {
  if (counter) counter.requests += 1;
  try {
    // fetchOne (oneShot): no redirect is followed and the body is capped, as for its item read.
    const res = oneShot ? await fetch(url, fetchOneInit(headers, oneShot.signal)) : await fetch(url, { headers });
    if (!res.ok) return { text: '', ok: false };
    let entries: DiscussionEntry[];
    if (oneShot) {
      const body = await readJsonCapped<DiscussionEntry[]>(res);
      if (!body.ok) return { text: '', ok: false };
      entries = body.value;
    } else {
      entries = (await res.json()) as DiscussionEntry[];
    }
    return { text: capSection(heading, formatEntries(entries, withState)), ok: true };
  } catch {
    return { text: '', ok: false };
  }
}

type ItemKind = 'pr' | 'issue';

/** Requests one item's discussion costs: issue comments, plus PR reviews and review comments. */
const discussionCost = (kind: ItemKind) => (kind === 'pr' ? 3 : 1);

/**
 * Comments and reviews for one item. Sequential, not Promise.all: GitHub's own
 * best-practices guidance is to make requests serially rather than concurrently to avoid
 * secondary rate limiting. PARALLEL_DISCUSSION_FETCHES already bounds how many ITEMS run
 * at once - firing 3 more requests concurrently per item would undo that bound.
 */
async function fetchDiscussion(
  kind: ItemKind,
  repo: string,
  n: number,
  headers: Record<string, string>,
  counter?: { requests: number },
  oneShot?: { signal: AbortSignal },
): Promise<{ text: string; failed: boolean }> {
  const sections =
    kind === 'pr'
      ? [
          [`${API}/repos/${repo}/issues/${n}/comments?per_page=20`, 'Comments', false],
          [`${API}/repos/${repo}/pulls/${n}/reviews?per_page=20`, 'Code Reviews', true],
          [`${API}/repos/${repo}/pulls/${n}/comments?per_page=20`, 'Review Comments', false],
        ] as const
      : ([[`${API}/repos/${repo}/issues/${n}/comments?per_page=20`, 'Comments', false]] as const);
  let text = '';
  let failed = false;
  for (const [url, heading, withState] of sections) {
    const out = await fetchSection(url, headers, heading, withState, counter, oneShot);
    text += out.text;
    if (!out.ok) failed = true;
  }
  return { text, failed };
}

function repoOf(item: GitHubSearchItem): string {
  return (item.repository_url ?? '').replace('https://api.github.com/repos/', '');
}

/** The text an item carries before its discussion. One writer, shared by the list fetch,
 *  the drain and fetchOne, so all three produce the same raw_text. */
function baseText(row: GitHubSearchItem, kind: ItemKind): string {
  if (kind === 'pr') {
    const status = row.pull_request?.merged_at ? 'merged' : row.state;
    return `${row.title}\n\n${row.body ?? ''}\n\nStatus: ${status}\nRepo: ${repoOf(row)}`.trim();
  }
  return `${row.title}\n\n${row.body ?? ''}\n\nStatus: ${row.state}`.trim();
}

/** The item mapper. `discussion` undefined means not fetched: pending when it could be. */
function toItem(row: GitHubSearchItem, kind: ItemKind, discussion: string | undefined): FetcherItem {
  const createdAt = toIsoOrUndefined(row.created_at);
  const updatedAt = toIsoOrUndefined(row.updated_at);
  const sourceKey = normaliseSourceKey('github', row.html_url);
  const fetchable = Boolean(repoOf(row)) && row.number != null;
  return {
    source_url: row.html_url,
    platform: 'github',
    raw_text: baseText(row, kind) + (discussion ?? ''),
    title: row.title,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(sourceKey ? { source_key: sourceKey } : {}),
    ...(row.user ? { author: { name: row.user.login, handle: row.user.login, url: row.user.html_url } } : {}),
    ...(discussion === undefined && fetchable ? { detail_pending: true } : {}),
  };
}

/**
 * `owner/repo`, number and kind from a PR or issue URL on github.com
 * (`/o/r/pull/12`, `/o/r/issues/7`) or api.github.com (`/repos/o/r/pulls/12`), else
 * undefined. The host is checked by {@link vendorUrl}; GitHub Enterprise is not read.
 */
function parseGitHubItemUrl(url: string): { repo: string; n: number; kind: ItemKind } | undefined {
  const u = vendorUrl(url, ['github.com', 'api.github.com']);
  if (!u) return undefined;
  const seg = '([A-Za-z0-9_.-]+)';
  const m =
    u.hostname.toLowerCase() === 'github.com'
      ? new RegExp(`^/${seg}/${seg}/(pull|issues)/(\\d+)(?:/.*)?$`).exec(u.pathname)
      : new RegExp(`^/repos/${seg}/${seg}/(pulls|issues)/(\\d+)/?$`).exec(u.pathname);
  if (!m) return undefined;
  return { repo: `${m[1]}/${m[2]}`, n: Number(m[4]), kind: m[3] === 'issues' ? 'issue' : 'pr' };
}

export interface GitHubDiscussionOptions {
  token: string;
  /** Request budget for this drain: an item is started only when its whole cost fits. */
  maxRequests: number;
}

export interface GitHubDiscussionResult {
  /** The items whose discussion was read in full, raw_text extended, detail_pending false. */
  items: FetcherItem[];
  /** page_cap: items the budget did not reach; error: items a section failed for (still
   *  pending); shape: inputs that are not a github.com PR or issue URL. */
  skips: FetchSkip[];
  /** Requests actually sent. */
  requests: number;
}

/**
 * The second tier (Decision 27): read comments and reviews for items an earlier
 * `discussion: 'none'` fetch returned with `detail_pending: true`, newest `updated_at`
 * first, and stop before `maxRequests`. Pass each item as the list fetch returned it: the
 * discussion is appended to its raw_text, so passing an already-enriched item doubles it.
 * An item a section failed for is not returned, so it stays pending for the next drain.
 */
export async function fetchGitHubDiscussion(items: FetcherItem[], opts: GitHubDiscussionOptions): Promise<GitHubDiscussionResult> {
  const headers = headersFor(opts.token);
  const parsed: Array<{ item: FetcherItem; repo: string; n: number; kind: ItemKind }> = [];
  let unreadable = 0;
  for (const item of items) {
    // Not pending: its discussion is already in raw_text (or was never deferred), and
    // appending again would double it. No request, and not counted as unreadable.
    if (item.detail_pending !== true) continue;
    const p = parseGitHubItemUrl(item.source_url);
    if (p) parsed.push({ item, ...p });
    else unreadable += 1;
  }
  const at = (i: FetcherItem) => {
    const ms = Date.parse(i.updated_at ?? '');
    return Number.isNaN(ms) ? -Infinity : ms;
  };
  parsed.sort((a, b) => at(b.item) - at(a.item));

  let reserved = 0;
  let reached = 0;
  for (const p of parsed) {
    if (reserved + discussionCost(p.kind) > opts.maxRequests) break;
    reserved += discussionCost(p.kind);
    reached += 1;
  }
  const plan = parsed.slice(0, reached);
  const counter = { requests: 0 };
  const results = await mapWithConcurrency(plan, PARALLEL_DISCUSSION_FETCHES, async (p) => ({
    p,
    out: await fetchDiscussion(p.kind, p.repo, p.n, headers, counter),
  }));

  const enriched: FetcherItem[] = [];
  let failed = 0;
  for (const { p, out } of results) {
    if (out.failed) {
      failed += 1;
      continue;
    }
    enriched.push({ ...p.item, raw_text: p.item.raw_text + out.text, detail_pending: false });
  }
  const skips: FetchSkip[] = [];
  const unreached = parsed.length - reached;
  if (unreached > 0) {
    skips.push({ kind: 'page_cap', count: unreached, detail: `items whose discussion was not read: the request budget of ${opts.maxRequests} ran out` });
  }
  if (failed > 0) skips.push({ kind: 'error', count: failed, detail: 'items whose discussion GitHub failed to return; they stay pending' });
  if (unreadable > 0) skips.push({ kind: 'shape', count: unreadable, detail: 'items that are not a github.com pull request or issue URL' });
  return { items: enriched, skips, requests: counter.requests };
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
 *
 * S2: with `since` the read is a window by updated date, sliced under GitHub's
 * 1,000-result ceiling; `discussion: 'none'` defers the per-item discussion to
 * {@link fetchGitHubDiscussion}; `scope: 'team'` with `repo` reads the whole repo.
 */
export class GitHubFetcher implements ConnectorFetcher {
  async fetch(opts: GitHubFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: GitHubFetcherOptions): Promise<FetchResult> {
    const clock = opts.clock ?? realClock;
    const deadline = deadlineFrom(opts.timeBudgetMs, clock);
    const headers = headersFor(opts.token);

    const win = parseWindow(opts.since, opts.until);
    if (!win.ok) {
      return refusedRead({ platform: 'github', requested: opts.limit ?? 100, scope: opts.scope === 'team' && opts.repo ? 'team' : 'yours', detail: win.detail });
    }

    // `repo` goes into the search query as a qualifier, so anything but a plain
    // owner/repo (a space, a `+`, a second qualifier) would widen the search past it.
    if (opts.repo !== undefined && !REPO_NAME.test(opts.repo)) {
      return refusedRead({
        platform: 'github',
        requested: opts.limit ?? 100,
        scope: opts.scope === 'team' ? 'team' : 'yours',
        detail: 'repo is not an owner/repo name (letters, digits, dot, dash, underscore); nothing was searched',
      });
    }

    const userRes = await fetch(`${API}/user`, { headers });
    if (!userRes.ok) {
      throw await providerError('GitHub', userRes, { forbidden: 'Check the token has the repo scope, or read access to the repositories.' });
    }
    const user = (await userRes.json()) as { login: string };

    const limit = opts.limit ?? 100;
    const team = opts.scope === 'team' && Boolean(opts.repo);
    const slices: DaySlice[] | undefined = win.since ? monthSlices(win.since, win.until, clock.now()) : undefined;
    const dated = (slice: DaySlice | undefined) => (slice ? `+${updatedQualifier(slice)}` : '');
    const ctx = newSearchContext({
      headers,
      limiter: new SlidingWindowLimiter(GH_SEARCHES_PER_MINUTE, 60_000, clock),
      clock,
      ...(deadline !== undefined ? { deadline } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
    });

    let prSearches: Array<Promise<{ rows: GitHubSearchItem[]; exhausted: boolean }>>;
    let issueSearch: Promise<{ rows: GitHubSearchItem[]; exhausted: boolean }>;
    if (team) {
      // Team scope: everyone's items in the named repo, by updated date. No involves:.
      prSearches = [readSearch((s) => `repo:${encodeURIComponent(opts.repo!)}${dated(s)}+type:pr`, slices, ctx, limit)];
      issueSearch = readSearch((s) => `repo:${encodeURIComponent(opts.repo!)}${dated(s)}+type:issue`, slices, ctx, limit);
    } else {
      // ALI-917: unscoped by default (every repo the token can see) - `opts.repo` narrows
      // to one `owner/repo` via GitHub's own search qualifier, so the filtering happens
      // server-side rather than fetching everything and discarding client-side.
      const repoQualifier = opts.repo ? `+repo:${encodeURIComponent(opts.repo)}` : '';
      prSearches = [
        readSearch((s) => `involves:${encodeURIComponent(user.login)}+type:pr${repoQualifier}${dated(s)}`, slices, ctx, limit),
        readSearch((s) => `reviewed-by:${encodeURIComponent(user.login)}+type:pr${repoQualifier}${dated(s)}`, slices, ctx, limit),
      ];
      issueSearch = readSearch((s) => `involves:${encodeURIComponent(user.login)}+type:issue${repoQualifier}${dated(s)}`, slices, ctx, limit);
    }
    const [issues, ...prs] = await Promise.all([issueSearch, ...prSearches]);

    // involves: and reviewed-by: can both return the same PR (e.g. you
    // authored it AND someone else reviewed you on it too) - dedupe before
    // the item ever reaches the discussion-fetch stage.
    const prByUrl = new Map<string, GitHubSearchItem>();
    for (const pr of prs.flatMap((p) => p.rows)) prByUrl.set(pr.html_url, pr);

    const rows = interleave([...prByUrl.values()], issues!.rows, limit);
    const searches = [issues!, ...prs];
    const exhausted = searches.every((s) => s.exhausted) && rows.length === prByUrl.size + issues!.rows.length;
    const skips: FetchSkip[] = searchSkips(ctx, opts.timeBudgetMs);

    const items = await mapWithConcurrency(rows, PARALLEL_DISCUSSION_FETCHES, async (r) => {
      // Discussion is the second tier: deferred by choice ('none'), or because the time
      // budget ran out. Either way the item itself is whole and says detail_pending, so
      // the drain can finish it; no skip, because nothing was left unread at item level.
      if (opts.discussion === 'none' || pastDeadline(deadline, clock)) return toItem(r.row, r.kind, undefined);
      const repo = repoOf(r.row);
      if (!repo || r.row.number == null) return toItem(r.row, r.kind, '');
      const discussion = await fetchDiscussion(r.kind, repo, r.row.number, headers);
      // A section that failed leaves the item pending, without the partial text: the
      // drain appends the whole discussion, so keeping part of it here would double it.
      return toItem(r.row, r.kind, discussion.failed ? undefined : discussion.text);
    });
    return {
      items,
      report: buildFetchReport(items, {
        platform: 'github',
        scanned: rows.length,
        requested: limit,
        skips,
        scope: team ? 'team' : 'yours',
        exhausted,
      }),
    };
  }

  /** Capture from a URL: one PR or issue, with its full discussion (about 4 requests). */
  async fetchOne(url: string, opts: FetchOneOptions): Promise<FetchOneResult> {
    const target = parseGitHubItemUrl(url);
    if (!target) return shapeSkip('URL is not a github.com pull request or issue');
    const timeoutMs = opts.timeoutMs ?? FETCH_ONE_TIMEOUT_MS;
    const headers = headersFor(opts.token);
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      // Built from the parsed ids on the fixed API host, never the pasted URL. The issues
      // endpoint answers for PRs too, in the same shape search returns, so the list
      // fetch's mapper applies unchanged (https://docs.github.com/en/rest/issues/issues#get-an-issue).
      const res = await fetch(`${API}/repos/${target.repo}/issues/${target.n}`, fetchOneInit(headers, signal));
      if (!res.ok) return statusSkip('GitHub', res.status);
      const body = await readJsonCapped<GitHubSearchItem>(res);
      if (!body.ok) return tooLargeSkip('GitHub');
      const row = body.value;
      const kind: ItemKind = row.pull_request ? 'pr' : 'issue';
      const discussion = await fetchDiscussion(kind, target.repo, target.n, headers, undefined, { signal });
      if (discussion.failed) {
        // Same rule as the list fetch: pending, no partial text. The skip says why.
        return {
          item: toItem(row, kind, undefined),
          skip: { kind: 'error', count: 1, detail: 'item returned without its discussion: a comments or reviews request to GitHub failed' },
        };
      }
      return { item: toItem(row, kind, discussion.text) };
    } catch (err) {
      return thrownSkip('GitHub', err, timeoutMs);
    }
  }
}
