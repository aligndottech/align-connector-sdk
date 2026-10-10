import type { FetchSkip } from '../../types/fetcher.js';
import { toIsoOrUndefined } from './time.js';

/**
 * The client-side stop for a listing the vendor sorts newest first but cannot filter by
 * date (Confluence v2 `sort=-modified-date`, Notion search `last_edited_time` descending,
 * Teams channel messages). One writer of the rule, so three fetchers cannot disagree.
 *
 * - At or after `until` (exclusive upper bound): drop, and keep reading; older items follow.
 * - At or after `since`: keep.
 * - Before `since`, while the order has held: stop. Everything after it is older.
 * - Before `since`, once an item arrived NEWER than the one before it: the vendor did not
 *   honour the sort, so stopping could leave newer items unread. Drop the item and keep
 *   reading to the end instead (the unsorted fallback), and count the disorder.
 * - No parseable time: keep, and count. It cannot be placed in the window, and dropping
 *   it would lose an item the caller may want.
 *
 * Both counts are `shape` skips: nothing is left unread by either, so they do not make a
 * read incomplete. A read that could never complete would never advance its watermark.
 */
export class DescendingWindow {
  private last: number | undefined;
  private ordered = true;
  private outOfOrder = 0;
  private undated = 0;

  constructor(
    private readonly since: number | undefined,
    private readonly until?: number,
  ) {}

  place(iso: string | undefined): 'keep' | 'drop' | 'stop' {
    if (this.since === undefined && this.until === undefined) return 'keep';
    const norm = toIsoOrUndefined(iso);
    if (!norm) {
      this.undated += 1;
      return 'keep';
    }
    const ms = Date.parse(norm);
    if (this.last !== undefined && ms > this.last) {
      this.outOfOrder += 1;
      this.ordered = false;
    }
    this.last = ms;
    if (this.until !== undefined && ms >= this.until) return 'drop';
    if (this.since === undefined || ms >= this.since) return 'keep';
    return this.ordered ? 'stop' : 'drop';
  }

  /** The counted skips, in a fixed order. `unit` names what was listed ("pages", "messages"). */
  skips(unit: string): FetchSkip[] {
    const out: FetchSkip[] = [];
    if (this.outOfOrder > 0) {
      out.push({
        kind: 'shape',
        count: this.outOfOrder,
        detail: `${unit} out of last-modified order (the sort was not honoured, so the read went past since and filtered instead of stopping)`,
      });
    }
    if (this.undated > 0) {
      out.push({ kind: 'shape', count: this.undated, detail: `${unit} with no last-modified time (kept: they cannot be placed in the window)` });
    }
    return out;
  }
}

/** True once `budgetMs` has elapsed since `startedAt`. No budget never expires. */
export function budgetSpent(startedAt: number, budgetMs: number | undefined): boolean {
  return budgetMs !== undefined && Date.now() - startedAt > budgetMs;
}

/**
 * A page cap from options: a finite whole number of at least 1, else the default. NaN,
 * Infinity, 0 and negatives would otherwise read nothing or read forever, silently.
 */
export function capOption(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}
