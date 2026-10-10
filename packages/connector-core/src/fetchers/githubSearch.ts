/**
 * GitHub issue/PR search under GitHub's own limits, with every limit that fires reported.
 *
 * Limits (https://docs.github.com/en/rest/search/search): at most 100 results a page and
 * 1,000 a query, 30 search requests a minute for an authenticated user, and an answer may
 * carry `incomplete_results: true` when GitHub's search timed out. The `updated:` qualifier
 * (https://docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests)
 * takes `>=YYYY-MM-DD` or an inclusive `YYYY-MM-DD..YYYY-MM-DD` range.
 *
 * A window is read as calendar-month slices, newest first. A slice whose `total_count` is
 * over 1,000 is halved until each half is under it or one day wide; a one-day slice still
 * over it is read to the ceiling and the rest is a `vendor_cap` skip.
 */
import { fetch } from 'undici';
import type { FetchSkip } from '../types/fetcher.js';
import { type Clock, SlidingWindowLimiter, pastDeadline } from './util/pace.js';

export interface GitHubSearchItem {
  html_url: string;
  title: string;
  body: string | null;
  state: string;
  /** When it was opened. Uniform across PRs and issues, unlike merged_at. */
  created_at?: string;
  /** When it last changed: the watermark field. */
  updated_at?: string;
  number?: number;
  repository_url?: string;
  user?: { login: string; html_url: string };
  /** Present (possibly with merged_at: null) only when the item is a PR. */
  pull_request?: { merged_at: string | null };
}

const GH_PER_PAGE_MAX = 100;
const GH_SEARCH_MAX_PAGES = 10;
const GH_SEARCH_CEILING = 1000;
/** GitHub's published search rate for an authenticated user. */
export const GH_SEARCHES_PER_MINUTE = 30;
const DAY_MS = 86_400_000;

/** An inclusive range of UTC day numbers (ms / DAY_MS). `to` undefined: open-ended. */
export interface DaySlice {
  from: number;
  to?: number;
}

const dayOf = (ms: number) => Math.floor(ms / DAY_MS);
const isoDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/**
 * `[since, until)` as calendar-month slices, newest first. Day granularity: `since` keeps
 * its whole first day and `until` its last partial day, so a slice reads a little more
 * than asked and never less (the consumer upserts, so an overlap costs nothing).
 */
export function monthSlices(since: string, until: string | undefined, nowMs: number): DaySlice[] {
  const start = dayOf(Date.parse(since));
  const end = until !== undefined ? Math.ceil(Date.parse(until) / DAY_MS) - 1 : undefined;
  const lastDay = end ?? Math.max(start, dayOf(nowMs));
  if (end !== undefined && end < start) return [];
  const out: DaySlice[] = [];
  let cursor = start;
  while (cursor <= lastDay) {
    const d = new Date(cursor * DAY_MS);
    const monthEnd = dayOf(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)) - 1;
    const sliceEnd = Math.min(monthEnd, lastDay);
    const open = end === undefined && sliceEnd === lastDay;
    out.push(open ? { from: cursor } : { from: cursor, to: sliceEnd });
    cursor = sliceEnd + 1;
  }
  return out.reverse();
}

/** The `updated:` qualifier for a slice, `>=` URL-encoded so the query string stays one parameter. */
export function updatedQualifier(slice: DaySlice): string {
  return slice.to === undefined ? `updated:%3E%3D${isoDay(slice.from)}` : `updated:${isoDay(slice.from)}..${isoDay(slice.to)}`;
}

/** Shared, mutable tally for one fetch: the searches run concurrently into it. */
export interface SearchContext {
  headers: Record<string, string>;
  limiter: SlidingWindowLimiter;
  clock: Clock;
  deadline?: number;
  /** The named repo, for naming it in an auth skip. */
  repo?: string;
  pastCeiling: number;
  incompleteSlices: number;
  failedPages: number[];
  authRefused: boolean;
  timedOutSearches: number;
}

export function newSearchContext(init: Pick<SearchContext, 'headers' | 'limiter' | 'clock' | 'deadline' | 'repo'>): SearchContext {
  return { ...init, pastCeiling: 0, incompleteSlices: 0, failedPages: [], authRefused: false, timedOutSearches: 0 };
}

interface SliceOutcome {
  rows: GitHubSearchItem[];
  exhausted: boolean;
  /** Stop the whole search (auth refused, or out of time). */
  stop?: boolean;
  /** Replace this slice with these, newest first. */
  split?: DaySlice[];
}

async function readSlice(q: string, slice: DaySlice | undefined, ctx: SearchContext, need: number, nowMs: number): Promise<SliceOutcome> {
  const rows: GitHubSearchItem[] = [];
  // Constant for the slice: `page` is an offset in units of per_page.
  const perPage = Math.min(need, GH_PER_PAGE_MAX);
  let total: number | undefined;
  let incomplete = false;
  for (let page = 1; page <= GH_SEARCH_MAX_PAGES; page++) {
    if (pastDeadline(ctx.deadline, ctx.clock) || !(await ctx.limiter.acquire(ctx.deadline))) {
      ctx.timedOutSearches += 1;
      return { rows, exhausted: false, stop: true };
    }
    const res = await fetch(`https://api.github.com/search/issues?q=${q}&sort=updated&per_page=${perPage}&page=${page}`, {
      headers: ctx.headers,
    });
    if (!res.ok) {
      if (res.status === 422 && ctx.repo) {
        ctx.authRefused = true;
        return { rows, exhausted: false, stop: true };
      }
      ctx.failedPages.push(res.status);
      return { rows, exhausted: false };
    }
    const data = (await res.json()) as { items?: GitHubSearchItem[]; total_count?: number; incomplete_results?: boolean };
    if (typeof data.total_count === 'number') total = data.total_count;
    if (data.incomplete_results === true && !incomplete) {
      incomplete = true;
      ctx.incompleteSlices += 1;
    }
    if (page === 1 && slice && total !== undefined && total > GH_SEARCH_CEILING) {
      const to = slice.to ?? Math.max(slice.from, dayOf(nowMs));
      if (to > slice.from) {
        const mid = slice.from + Math.floor((to - slice.from) / 2);
        return { rows: [], exhausted: true, split: [{ from: mid + 1, to }, { from: slice.from, to: mid }] };
      }
    }
    const batch = data.items ?? [];
    rows.push(...batch);
    if (batch.length < perPage) return { rows, exhausted: !incomplete };
    if (rows.length >= need) return { rows: rows.slice(0, need), exhausted: false };
  }
  // Ten full pages that were exactly the whole result (total_count 1,000) ended nothing.
  if (total !== undefined && rows.length >= total) return { rows, exhausted: !incomplete };
  // Ten full pages and still short of `need`: the ceiling ended the read.
  ctx.pastCeiling += Math.max((total ?? rows.length + 1) - rows.length, 1);
  return { rows, exhausted: false };
}

/**
 * Read one search (`base` plus, per slice, its `updated:` qualifier) until `target` rows,
 * the end of the window, or a stop. `withSlice` builds the query for a slice; with no
 * slices (no `since`) the query is read once, unsliced, exactly as before S2.
 */
export async function readSearch(
  withSlice: (slice: DaySlice | undefined) => string,
  slices: DaySlice[] | undefined,
  ctx: SearchContext,
  target: number,
): Promise<{ rows: GitHubSearchItem[]; exhausted: boolean }> {
  const nowMs = ctx.clock.now();
  const queue: Array<DaySlice | undefined> = slices ? [...slices] : [undefined];
  const rows: GitHubSearchItem[] = [];
  let exhausted = true;
  while (queue.length > 0 && rows.length < target) {
    const slice = queue.shift();
    const out = await readSlice(withSlice(slice), slice, ctx, target - rows.length, nowMs);
    if (out.split) {
      queue.unshift(...out.split);
      continue;
    }
    rows.push(...out.rows);
    if (!out.exhausted) exhausted = false;
    if (out.stop) return { rows, exhausted: false };
  }
  if (queue.length > 0) exhausted = false;
  return { rows, exhausted };
}

/** The skips a finished set of searches earned. */
export function searchSkips(ctx: SearchContext, budgetMs: number | undefined): FetchSkip[] {
  const skips: FetchSkip[] = [];
  if (ctx.authRefused && ctx.repo) {
    skips.push({
      kind: 'auth',
      count: 1,
      detail: `repository not searched: GitHub will not search ${ctx.repo} for this token (HTTP 422: it cannot see the repository, or it does not exist)`,
    });
  }
  if (ctx.failedPages.length > 0) {
    const statuses = [...new Set(ctx.failedPages)].join(', ');
    skips.push({ kind: 'error', count: ctx.failedPages.length, detail: `search pages GitHub failed to return (HTTP ${statuses})` });
  }
  if (ctx.pastCeiling > 0) {
    skips.push({ kind: 'vendor_cap', count: ctx.pastCeiling, detail: "search results past GitHub's 1,000-result search ceiling, not read" });
  }
  if (ctx.incompleteSlices > 0) {
    skips.push({
      kind: 'vendor_cap',
      count: ctx.incompleteSlices,
      detail: 'searches GitHub answered with incomplete_results (its search timed out, so results may be missing)',
    });
  }
  if (ctx.timedOutSearches > 0) {
    skips.push({
      kind: 'time_budget',
      count: ctx.timedOutSearches,
      detail: `searches stopped at the ${budgetMs ?? 0} ms time budget (GitHub allows ${GH_SEARCHES_PER_MINUTE} searches a minute); older results not read`,
    });
  }
  return skips;
}
