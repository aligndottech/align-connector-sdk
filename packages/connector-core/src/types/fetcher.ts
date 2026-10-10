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
  /**
   * The source's own last-updated time for this item, ISO-8601 Z. It feeds
   * {@link FetchReport.highWater}, the watermark an incremental sync resumes from,
   * so the same rule as `created_at` holds: absent when the source did not say,
   * never the fetch time. Set by every built-in token fetcher (github, gitlab, jira,
   * linear in S2; confluence, notion, slack, teams, zoom in S3).
   */
  updated_at?: string;
  /**
   * `normaliseSourceKey(platform, source_url)`, for sources where one URL names
   * exactly one item (a PR, issue, MR, page, Slack thread, Teams message, Zoom meeting,
   * git commit). A consumer keys an upsert on it, so an edited title updates one row
   * instead of adding a second. Absent where several items can share a URL, and
   * wherever normaliseSourceKey returns undefined (a synthetic or fallback URL).
   *
   * Set by every built-in token fetcher where the key exists (S2, S3); absent on the Teams
   * fallback URL. For any other fetcher a consumer that wants a key calls
   * normaliseSourceKey on `source_url` itself.
   */
  source_key?: string;
  /**
   * True when the item was returned whole but its discussion (comments, reviews) was
   * deferred: GitHub's two-tier read (`discussion: 'none'`, or a time budget that ran out
   * before the discussion pass). The item is still complete as an item; a consumer
   * finishes it later (GitHub: `fetchGitHubDiscussion`). Absent or false: nothing pending.
   */
  detail_pending?: boolean;
  /**
   * True when this item holds only PART of what its `source_url` names: a Slack hot-thread
   * re-read (only the messages since `since`), or a thread cut at a reply cap (Slack
   * maxReplyPages, Teams more replies than one expanded page or than fetchOne's reply cap),
   * or a Notion page whose body could not be read or was cut at maxBlockPages.
   * It shares `source_url` and `source_key` with the whole item, so a consumer must MERGE
   * it into a stored row, never replace the stored text with it. Absent when whole.
   */
  partial?: boolean;
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
  /**
   * Narrow a search-driven fetcher (GitHub) to one `owner/repo`. Absent means every repo the
   * token can see, which is GitHub's own default and this SDK's default until ALI-917 - a
   * personal token spanning several unrelated repos (different orgs, different languages)
   * otherwise returns a mixed, undifferentiated result with no way to ask for less.
   */
  repo?: string;
  /**
   * Slack only: threads the caller already holds whose roots may be older than `since`;
   * their replies since `since` are re-read. Requires `since`: without it the read is
   * refused (a `shape` skip, nothing read). Each resulting item is `partial: true` and
   * shares its key with the stored thread, so a consumer must MERGE it into the stored
   * row (append the new messages), never replace the stored text with it.
   */
  hotThreads?: Array<{ channel: string; ts: string }>;
  /**
   * Wall-clock budget for the whole read, in milliseconds. A fetcher that stops
   * because it ran out reports a `time_budget` skip, so the report says the read
   * is incomplete rather than looking thin.
   */
  timeBudgetMs?: number;
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
   *  fired; vendor_cap: the provider's own ceiling stopped the read (GitHub search
   *  returns at most 1,000 results); shape: the source object was not the kind this
   *  fetcher reads; pending: the provider has the object but it is not ready yet (a
   *  Zoom transcript still processing), so a later read will find it; error: the
   *  provider refused or failed the read; auth: the provider refused the token for
   *  part of the read.
   *
   *  Every kind except `shape` means something was left UNREAD, so the report is
   *  not `complete` (see {@link INCOMPLETE_SKIP_KINDS}). The union grows over time:
   *  a consumer switching on it needs a default branch. */
  kind: 'page_cap' | 'time_budget' | 'vendor_cap' | 'shape' | 'pending' | 'error' | 'auth';
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
  /**
   * The latest `updated_at` among the returned items: where the next incremental
   * read resumes. Absent when no item carried one, never `now()`, because a
   * watermark set to the fetch time skips whatever the source had not yet shown.
   *
   * A consumer MUST NOT advance a watermark when this is absent, even on
   * `complete: true`, and MUST NOT substitute `now()`, `created_at` or the newest
   * item's position for it. `created_at` is not an updated time: an old item edited
   * today would sit below a watermark built from it and never be re-read. Only items
   * that carry `updated_at` can produce one.
   *
   * When the read had an `until`, this is clamped to it (as is {@link oldestReached}): an
   * item that slipped past the bound cannot move the watermark beyond the window asked for.
   */
  highWater?: string;
  /** The earliest `updated_at` among the returned items. Absent like `highWater`, and
   *  clamped to `until` the same way, so it never sits above `highWater`. */
  oldestReached?: string;
  /**
   * True only when the read reached the end of what it was asked for: no cap, time
   * budget, vendor ceiling, error or auth skip fired, and the source said there was
   * nothing more. A sync advances its watermark only on `true` AND a present
   * {@link highWater}, so a fetcher that cannot tell says `false`: a false `false`
   * costs one re-read, a false `true` loses items for good. `complete` alone is not a
   * watermark: it says the read was whole, not how far it reached.
   */
  complete: boolean;
  /** 'yours': only the caller's own items (authored, assigned, involved). 'team':
   *  everything the token can read, other people's items included. */
  scope: 'yours' | 'team';
  /**
   * Items returned per named sub-scope the caller asked for (Confluence: per space key),
   * so a multi-space read can say which space gave what. Absent where the fetcher reads
   * one undivided scope.
   */
  perScope?: Record<string, number>;
}

export interface FetchResult {
  items: FetcherItem[];
  report: FetchReport;
}

/** Inputs to {@link FetchOne}. Per-provider extras (`cloudId`, `siteBase`, `domain`,
 *  `email`) ride on the index signature exactly as they do for a list fetch.
 *
 *  SECURITY: `token` is a stored credential, and `cloudId`, `siteBase`, `domain` and any
 *  other host-like option decide where it is sent. They MUST come from the connector's
 *  stored configuration for this credential, never from the caller, an agent's tool
 *  arguments, or the URL being captured. The consumer is an MCP tool: if an agent can
 *  choose `domain`, it can send the token to a host it picks. fetchOne checks the URL
 *  against these options; it cannot check the options themselves. */
export interface FetchOneOptions {
  token: string;
  /** Wall-clock limit for the whole single-item read, ms. Default 3,000. Running out is a
   *  `time_budget` skip. */
  timeoutMs?: number;
  [key: string]: unknown;
}

/** One of the two is set, except GitHub's partial read: an item whose discussion failed
 *  comes back with `detail_pending: true` AND an `error` skip saying so. */
export interface FetchOneResult {
  item?: FetcherItem;
  skip?: FetchSkip;
  /** Only beside an `item`: what the read left out (a cap that fired, or a body it could
   *  not read: the item is then `partial: true`) or set aside (a `shape` skip naming an
   *  option that fell back to its default; the item can still be whole). Absent when the
   *  item is whole and every option was used as given. */
  skips?: FetchSkip[];
}

/**
 * Single-item read for capture-from-URL. Built from the same item mapper the list fetch
 * uses, so a captured item and an imported one carry identical fields. Never throws for
 * a vendor error: 401/403 is an `auth` skip, 404 and other failures `error`, a timeout
 * `time_budget`. A URL this fetcher does not recognise, or one on a host other than the
 * one the token belongs to, is a `shape` skip made with NO request, so a token is never
 * sent to a host taken from the URL.
 */
export type FetchOne = (url: string, opts: FetchOneOptions) => Promise<FetchOneResult>;

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
  /** Optional single-item read for capture-from-URL. See {@link FetchOne}. */
  fetchOne?: FetchOne;
}
