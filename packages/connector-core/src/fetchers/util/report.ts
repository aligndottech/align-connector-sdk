import type { FetcherItem, FetchReport, FetchResult, FetchSkip } from '../../types/fetcher.js';
import { toIsoOrUndefined } from './time.js';

/**
 * Skip kinds that mean something was left UNREAD. `shape` is absent on purpose: a
 * shape skip is an object the fetcher read and set aside (a one-message Slack post,
 * a meeting with no transcript), so the read can still be complete.
 */
export const INCOMPLETE_SKIP_KINDS: ReadonlySet<FetchSkip['kind']> = new Set<FetchSkip['kind']>([
  'page_cap',
  'time_budget',
  'vendor_cap',
  'pending',
  'error',
  'auth',
]);

export interface FetchReportParts {
  platform: string;
  scanned: number;
  requested?: number;
  skips: FetchSkip[];
  scope: FetchReport['scope'];
  perScope?: FetchReport['perScope'];
  /**
   * The fetcher's own evidence that the source had nothing more: the last page was
   * short, no cursor came back, the item limit did not cut the read. False whenever
   * the fetcher cannot tell.
   */
  exhausted: boolean;
}

/**
 * Assemble a {@link FetchReport}: one writer for `complete`, `highWater` and
 * `oldestReached`, so ten fetchers cannot disagree about what they mean.
 *
 * `highWater` and `oldestReached` come ONLY from item `updated_at`. With none, they are
 * absent, and this function never fills them from `created_at` or the clock: a
 * consumer must then not advance a watermark (see {@link FetchReport.highWater}).
 */
export function buildFetchReport(items: FetcherItem[], parts: FetchReportParts): FetchReport {
  const { exhausted, ...rest } = parts;
  let high: number | undefined;
  let low: number | undefined;
  for (const item of items) {
    // Parsed and NaN-checked: an unparseable time is ignored, never compared.
    const iso = toIsoOrUndefined(item.updated_at);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (high === undefined || ms > high) high = ms;
    if (low === undefined || ms < low) low = ms;
  }
  const complete = exhausted && !parts.skips.some((s) => INCOMPLETE_SKIP_KINDS.has(s.kind));
  return {
    ...rest,
    complete,
    ...(high !== undefined ? { highWater: new Date(high).toISOString() } : {}),
    ...(low !== undefined ? { oldestReached: new Date(low).toISOString() } : {}),
  };
}

/**
 * The result of a read refused before any request, because an input is not usable (a
 * repo that is not `owner/repo`, a `since` that is not a date). Nothing was read, so it
 * is never `complete`, even though the skip kind is `shape`: the report says which input
 * to fix, and a consumer must not advance a watermark on it.
 */
export function refusedRead(parts: { platform: string; requested: number; scope: FetchReport['scope']; detail: string }): FetchResult {
  const { detail, ...rest } = parts;
  return {
    items: [],
    report: buildFetchReport([], { ...rest, scanned: 0, skips: [{ kind: 'shape', count: 1, detail }], exhausted: false }),
  };
}
