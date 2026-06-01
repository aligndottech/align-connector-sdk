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

export interface ConnectorFetcher {
  /** Single-shot read used by the CLI personal import. */
  fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]>;
  /** Optional paged read used by the discover scan. Defaults can wrap `fetch`. */
  fetchPage?(opts: ConnectorFetcherOptions): Promise<FetcherPage>;
}
