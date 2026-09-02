/**
 * The connector read contract.
 *
 * A `ConnectorFetcher` is the single thing a contributor implements to add a new
 * connector: given a read-only token it returns normalized {@link FetcherItem}s.
 * The SAME implementation drives two surfaces:
 *   - the free Align CLI, which calls {@link ConnectorFetcher.fetch} directly, and
 *   - the paid discover scan, which calls {@link ConnectorFetcher.fetchPage} from
 *     inside Align's (closed) queue/fan-out orchestration via the connector's
 *     `fetch_historical` MCP tool.
 *
 * Nothing about how the scan is orchestrated (queues, fan-out, dedup) lives here.
 */

/** The human behind a decision - "who to talk to". */
export interface DecisionAuthor {
  name: string;
  handle?: string;
  email?: string;
  url?: string;
}

/** A normalized, source-agnostic item produced by a fetcher. */
export interface FetcherItem {
  source_url: string;
  platform: string;
  raw_text: string;
  title?: string;
  /** Who to talk to about this item (decision owner / author), when resolvable. */
  author?: DecisionAuthor;
  /**
   * The source's own timestamp for this item, ISO-8601 Z: when it was created
   * on most platforms, and for Confluence the current version's date (the page
   * as it now stands), which is what the hosted scan records as decided_at for
   * Confluence too. Never the fetch time: absent means the platform did not
   * say, and a consumer that wants "now" must write it itself where it can be
   * seen, because a plausible wrong date is indistinguishable from a
   * measurement downstream.
   */
  created_at?: string;
}

/**
 * Inputs to a fetch. `token` + `limit` cover the CLI personal import; `cursor`
 * and the `since`/`until` window let the paid scan page through larger ranges.
 * Per-provider extras (e.g. `cloudId`, `siteBase`, `domain`) ride on the index
 * signature.
 */
export interface ConnectorFetcherOptions {
  token: string;
  /** Max items to return (CLI personal cap). */
  limit?: number;
  /** Opaque continuation token for paged fetches (paid scan). */
  cursor?: string;
  /** ISO-8601 lower bound (inclusive) for the fetch window. */
  since?: string;
  /** ISO-8601 upper bound (exclusive) for the fetch window. */
  until?: string;
  [key: string]: unknown;
}

/** One page of results plus an optional continuation cursor. */
export interface FetcherPage {
  items: FetcherItem[];
  nextCursor?: string;
}

/**
 * What a fetch could NOT reach, in the fetcher's own terms.
 *
 * Plumbing only: a count and a reason the fetcher measured. Never a judgement
 * about whether an item was a decision - that stays on the proprietary side.
 * The CLI prints these verbatim, which is why `detail` is written for a person
 * and reads as a sentence after the count: "12 channels not scanned (...)".
 */
export interface FetchSkip {
  /** page_cap: a page or item cap fired; time_budget: the fetcher's own deadline
   *  fired; shape: the source object was not the kind this fetcher reads; error:
   *  the provider refused or failed the read. */
  kind: 'page_cap' | 'time_budget' | 'shape' | 'error';
  count: number;
  detail: string;
}

export interface FetchReport {
  platform: string;
  /** Source objects examined before any filter, in the fetcher's own unit (Slack
   *  counts threads). `items.length` is never more than this. */
  scanned: number;
  /** The cap the read was bounded by: `opts.limit`, or the fetcher's default when
   *  none was given. Lets a caller say "30 of up to 50" without re-deriving it. */
  requested?: number;
  /**
   * Lines for a person, not terms of an equation. A skip's count is in whatever
   * unit its detail names, which need not be `scanned`'s (Slack's short-message
   * skip counts messages while `scanned` counts threads); skips are not disjoint
   * from `items` (a thread cut at a page cap is kept AND reported) nor from each
   * other. Do not reconcile `scanned - skips = items`.
   */
  skips: FetchSkip[];
}

export interface FetchResult {
  items: FetcherItem[];
  report: FetchReport;
}

export interface ConnectorFetcher {
  /** Single-shot read used by the CLI personal import. */
  fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]>;
  /** Optional paged read used by the discover scan. Defaults can wrap `fetch`. */
  fetchPage?(opts: ConnectorFetcherOptions): Promise<FetcherPage>;
  /**
   * The same read as {@link fetch}, plus what it could not reach. Optional so
   * every existing implementation (in this repo and in anyone else's) still
   * satisfies the interface unchanged. Where both exist, `fetch` must return
   * exactly `(await fetchWithReport(opts)).items`.
   */
  fetchWithReport?(opts: ConnectorFetcherOptions): Promise<FetchResult>;
}
