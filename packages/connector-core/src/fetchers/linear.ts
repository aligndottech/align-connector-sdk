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

const LINEAR_GQL = 'https://api.linear.app/graphql';
const LINEAR_PAGE_MAX = 100;

/**
 * Comments per issue. Linear scores a query by the nodes it asks for and rejects a
 * single query over 10,000 points; a page of 100 issues carrying the connection's
 * default of 50 comments each would be over that. 20 keeps the page well under.
 * (An earlier version of this comment blamed the first live import's 400 on this
 * limit; Linear's own message showed it was the Authorization header, see below.)
 */
const LINEAR_COMMENTS_MAX = 20;

/**
 * Linear takes a personal API key bare and an OAuth access token with `Bearer`, and
 * refuses the other way round with HTTP 400: "It looks like you're trying to use an
 * API key as a Bearer token. Remove the Bearer prefix from the Authorization header."
 * That was the first live local-mode Linear import, 2026-09-03; the CLI's local mode
 * pastes API keys, so Linear had never worked there. Keys are prefixed `lin_api_`,
 * OAuth tokens `lin_oauth_`.
 */
function authorizationFor(token: string): string {
  return token.startsWith('lin_api_') ? token : `Bearer ${token}`;
}

const ISSUE_FIELDS = `
  id title description url createdAt updatedAt
  state { name }
  team { name }
  creator { name email }
  comments(first: ${LINEAR_COMMENTS_MAX}) { nodes { body user { name } } }
`;

/**
 * Requests an hour Linear allows this token (https://linear.app/developers/rate-limiting):
 * 2,500 for a personal API key, 5,000 for an OAuth app token. The read is paced to it.
 */
export function linearRequestsPerHour(token: string): number {
  return token.startsWith('lin_api_') ? 2_500 : 5_000;
}

/**
 * Below this many requests left in Linear's hour (`X-RateLimit-Requests-Remaining`), the
 * read stops with a vendor_cap skip rather than spend the rest: the same key serves the
 * user's other tools, and running into the limit fails them too.
 */
const LINEAR_REQUESTS_FLOOR = 50;

interface LinearIssueNode {
  id: string;
  title: string;
  description: string | null;
  url: string;
  createdAt?: string;
  updatedAt?: string;
  state?: { name: string };
  team?: { name: string };
  creator?: { name?: string; email?: string };
  comments?: { nodes: Array<{ body: string; user?: { name: string } }> };
}

/** Linear-specific read options. `teams` (team ids) reads everyone's issues in those
 *  teams (`scope: 'team'`); without it the read stays the caller's assigned and created issues. */
export interface LinearFetcherOptions extends ConnectorFetcherOptions {
  teams?: string[];
  /** Test seam for pacing and the time budget. */
  clock?: Clock;
}

type LinearSource = { kind: 'viewer'; field: 'assignedIssues' | 'createdIssues' } | { kind: 'issues' };

/** Shared by the concurrent connection reads of one fetch. */
interface ReadContext {
  token: string;
  limiter: SlidingWindowLimiter;
  clock: Clock;
  deadline?: number;
  filter?: Record<string, unknown>;
  failedPages: number[];
  timedOut: boolean;
  /** Requests Linear said were left when the read stopped for the floor. */
  rateStoppedAt?: number;
}

function pageQuery(source: LinearSource, filtered: boolean): string {
  const args = `first: $first, after: $after, orderBy: updatedAt${filtered ? ', filter: $filter' : ''}`;
  const vars = `$first: Int!, $after: String${filtered ? ', $filter: IssueFilter' : ''}`;
  const conn = source.kind === 'issues' ? 'issues' : source.field;
  const select = `${conn}(${args}) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      }`;
  return source.kind === 'issues' ? `query Page(${vars}) { ${select} }` : `query Page(${vars}) {
      viewer { ${select} }
    }`;
}

/** Page through one issue connection up to `target`. The first page's failure throws (it
 *  is the token's verdict); a later one is an error skip and keeps what was read. */
async function fetchConnection(source: LinearSource, ctx: ReadContext, target: number): Promise<{ nodes: LinearIssueNode[]; exhausted: boolean }> {
  const out: LinearIssueNode[] = [];
  let after: string | undefined;
  let first = true;
  while (out.length < target) {
    if (pastDeadline(ctx.deadline, ctx.clock) || !(await ctx.limiter.acquire(ctx.deadline))) {
      ctx.timedOut = true;
      return { nodes: out, exhausted: false };
    }
    const res = await fetch(LINEAR_GQL, {
      method: 'POST',
      headers: { Authorization: authorizationFor(ctx.token), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: pageQuery(source, ctx.filter !== undefined),
        variables: { first: Math.min(target - out.length, LINEAR_PAGE_MAX), after, ...(ctx.filter ? { filter: ctx.filter } : {}) },
      }),
    });
    // Linear answers a bad or missing key with 401 and a refused REQUEST (invalid query,
    // over the complexity limit) with 400; providerError keeps the two apart.
    if (!res.ok) {
      if (first) throw await providerError('Linear', res);
      ctx.failedPages.push(res.status);
      return { nodes: out, exhausted: false };
    }
    const json = (await res.json()) as {
      errors?: Array<{ message: string }>;
      data?: Record<string, unknown> & { viewer?: Record<string, unknown> };
    };
    if (json.errors?.length) {
      if (first) throw new Error(json.errors[0]!.message);
      ctx.failedPages.push(200);
      return { nodes: out, exhausted: false };
    }
    first = false;
    const holder = source.kind === 'issues' ? json.data : json.data?.viewer;
    const conn = holder?.[source.kind === 'issues' ? 'issues' : source.field] as
      | { nodes: LinearIssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string } }
      | undefined;
    if (!conn) break;
    out.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) return { nodes: out, exhausted: true };
    after = conn.pageInfo.endCursor;
    const remaining = Number(res.headers?.get?.('x-ratelimit-requests-remaining') ?? NaN);
    if (!Number.isNaN(remaining) && remaining < LINEAR_REQUESTS_FLOOR && out.length < target) {
      ctx.rateStoppedAt = remaining;
      return { nodes: out, exhausted: false };
    }
  }
  return { nodes: out, exhausted: false };
}

/** The item mapper, shared by the list fetch and fetchOne. */
function toItem(issue: LinearIssueNode): FetcherItem {
  const createdAt = toIsoOrUndefined(issue.createdAt);
  const updatedAt = toIsoOrUndefined(issue.updatedAt);
  const sourceKey = normaliseSourceKey('linear', issue.url);
  const comments = (issue.comments?.nodes ?? []).map((c) => `${c.user?.name ?? 'Unknown'}: ${c.body}`).join('\n');
  return {
    source_url: issue.url,
    platform: 'linear',
    raw_text: [
      issue.title,
      issue.description ?? '',
      issue.team?.name ? `Team: ${issue.team.name}` : '',
      issue.state?.name ? `Status: ${issue.state.name}` : '',
      comments ? `Comments:\n${comments}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    title: issue.title,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(sourceKey ? { source_key: sourceKey } : {}),
    ...(issue.creator?.name ? { author: { name: issue.creator.name, ...(issue.creator.email ? { email: issue.creator.email } : {}) } } : {}),
  };
}

/**
 * Read-only Linear fetcher. Author = the issue creator. Paginates each connection up to
 * `limit`.
 *
 * Personal (no `teams`): the caller's assigned + created issues (deduped). Team (`teams`):
 * the top-level `issues` connection filtered to those teams. Both bound `since`/`until`
 * with an `updatedAt` filter (https://linear.app/developers/filtering), and pace to the
 * token's hourly request limit.
 */
export class LinearFetcher implements ConnectorFetcher {
  async fetch(opts: LinearFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: LinearFetcherOptions): Promise<FetchResult> {
    const clock = opts.clock ?? realClock;
    const limit = opts.limit ?? 50;
    const teams = opts.teams ?? [];
    const team = teams.length > 0;
    const win = parseWindow(opts.since, opts.until);
    if (!win.ok) return refusedRead({ platform: 'linear', requested: limit, scope: team ? 'team' : 'yours', detail: win.detail });
    const { since, until } = win;
    const updatedAt = since || until ? { ...(since ? { gte: since } : {}), ...(until ? { lt: until } : {}) } : undefined;
    const filter =
      team || updatedAt ? { ...(team ? { team: { id: { in: teams } } } : {}), ...(updatedAt ? { updatedAt } : {}) } : undefined;
    const deadline = deadlineFrom(opts.timeBudgetMs, clock);
    const ctx: ReadContext = {
      token: opts.token,
      limiter: new SlidingWindowLimiter(linearRequestsPerHour(opts.token), 3_600_000, clock),
      clock,
      ...(deadline !== undefined ? { deadline } : {}),
      ...(filter ? { filter } : {}),
      failedPages: [],
      timedOut: false,
    };

    const reads = team
      ? [await fetchConnection({ kind: 'issues' }, ctx, limit)]
      : await Promise.all([
          fetchConnection({ kind: 'viewer', field: 'assignedIssues' }, ctx, limit),
          fetchConnection({ kind: 'viewer', field: 'createdIssues' }, ctx, limit),
        ]);

    const seen = new Set<string>();
    const items: FetcherItem[] = [];
    let scanned = 0;
    let cutByLimit = false;
    for (const issue of reads.flatMap((r) => r.nodes)) {
      if (items.length >= limit) {
        // Unread only if it is not a duplicate of one already kept.
        if (!seen.has(issue.id)) cutByLimit = true;
        continue;
      }
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      scanned += 1;
      items.push(toItem(issue));
    }

    const skips: FetchSkip[] = [];
    if (ctx.failedPages.length > 0) {
      skips.push({
        kind: 'error',
        count: ctx.failedPages.length,
        detail: `issue pages Linear failed to return (HTTP ${[...new Set(ctx.failedPages)].join(', ')})`,
      });
    }
    if (ctx.rateStoppedAt !== undefined) {
      skips.push({
        kind: 'vendor_cap',
        count: 1,
        detail: `issue read stopped: Linear says ${ctx.rateStoppedAt} requests are left this hour, so it stopped rather than run into the limit`,
      });
    }
    if (ctx.timedOut) skips.push({ kind: 'time_budget', count: 1, detail: `issue read stopped at the ${opts.timeBudgetMs} ms time budget; older issues not read` });

    const exhausted = reads.every((r) => r.exhausted) && !cutByLimit;
    return { items, report: buildFetchReport(items, { platform: 'linear', scanned, requested: limit, skips, scope: team ? 'team' : 'yours', exhausted }) };
  }

  /**
   * Capture from a URL: `https://linear.app/<workspace>/issue/<KEY>[/<slug>]`, one
   * `issue(id:)` query by identifier. Only linear.app is read.
   */
  async fetchOne(url: string, opts: FetchOneOptions): Promise<FetchOneResult> {
    const u = vendorUrl(url, ['linear.app']);
    if (!u) return shapeSkip('URL is not a linear.app issue');
    const key = /^\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:\/[^/]*)?\/?$/.exec(u.pathname)?.[1];
    if (!key) return shapeSkip('URL is not a Linear issue (expected /<workspace>/issue/<KEY>-<number>)');
    const timeoutMs = opts.timeoutMs ?? FETCH_ONE_TIMEOUT_MS;
    try {
      // The identifier goes in as a GraphQL variable to the fixed API host, never the pasted URL.
      const res = await fetch(LINEAR_GQL, {
        method: 'POST',
        ...fetchOneInit({ Authorization: authorizationFor(opts.token), 'Content-Type': 'application/json' }, AbortSignal.timeout(timeoutMs)),
        body: JSON.stringify({ query: `query One($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, variables: { id: key } }),
      });
      if (!res.ok) return statusSkip('Linear', res.status);
      const body = await readJsonCapped<{ errors?: Array<{ message: string }>; data?: { issue?: LinearIssueNode | null } }>(res);
      if (!body.ok) return tooLargeSkip('Linear');
      const issue = body.value.data?.issue;
      if (!issue) {
        return { skip: { kind: 'error', count: 1, detail: `item Linear could not return (${body.value.errors?.[0]?.message ?? 'no such issue'})` } };
      }
      return { item: toItem(issue) };
    } catch (err) {
      return thrownSkip('Linear', err, timeoutMs);
    }
  }
}
