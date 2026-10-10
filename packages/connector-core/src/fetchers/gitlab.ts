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
import { type Clock, deadlineFrom, pastDeadline, realClock } from './util/pace.js';
import { FETCH_ONE_TIMEOUT_MS, fetchOneInit, readJsonCapped, shapeSkip, statusSkip, thrownSkip, tooLargeSkip, vendorUrl } from './util/single.js';

interface GitLabMergeRequest {
  web_url: string;
  title: string;
  description: string | null;
  state: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * GitLab-specific read options. `projectId` (numeric id or `group/project` path) reads
 * everyone's merge requests in that project (`scope: 'team'`); without it the read stays
 * the caller's own merged MRs.
 */
export interface GitLabFetcherOptions extends ConnectorFetcherOptions {
  projectId?: string | number;
  /** Self-managed host. Default gitlab.com. */
  domain?: string;
  /** Test seam for the time budget. */
  clock?: Clock;
}

// GitLab's own per-page maximum. Before ALI-828 the read was one page of at
// most 50, a cap nobody had chosen, whatever the caller asked for.
const GITLAB_PAGE_MAX = 100;

/** The item mapper, shared by the list fetch and fetchOne. */
function toItem(mr: GitLabMergeRequest): FetcherItem {
  const createdAt = toIsoOrUndefined(mr.created_at);
  const updatedAt = toIsoOrUndefined(mr.updated_at);
  const sourceKey = normaliseSourceKey('gitlab', mr.web_url);
  return {
    source_url: mr.web_url,
    platform: 'gitlab',
    raw_text: `${mr.title}\n\n${mr.description ?? ''}\n\nStatus: ${mr.state}`.trim(),
    title: mr.title,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(sourceKey ? { source_key: sourceKey } : {}),
  };
}

/**
 * Read-only GitLab fetcher, paged by page number up to `limit` (a page shorter than
 * requested is the last). `domain` (default gitlab.com) rides on the options.
 *
 * Personal (no `projectId`): the caller's merged merge requests, as before S2.
 * Team (`projectId`): `GET /projects/:id/merge_requests?state=all&order_by=updated_at&sort=desc`.
 * Both bound `since`/`until` with GitLab's `updated_after`/`updated_before`
 * (https://docs.gitlab.com/api/merge_requests/).
 */
export class GitLabFetcher implements ConnectorFetcher {
  async fetch(opts: GitLabFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: GitLabFetcherOptions): Promise<FetchResult> {
    const clock = opts.clock ?? realClock;
    const deadline = deadlineFrom(opts.timeBudgetMs, clock);
    const domain = opts.domain ?? 'gitlab.com';
    const base = `https://${domain}/api/v4`;
    const headers = { Authorization: `Bearer ${opts.token}` };
    const team = opts.projectId !== undefined && opts.projectId !== '';

    const win = parseWindow(opts.since, opts.until);
    if (!win.ok) return refusedRead({ platform: 'gitlab', requested: opts.limit ?? 100, scope: team ? 'team' : 'yours', detail: win.detail });
    const window = new URLSearchParams();
    if (win.since) window.set('updated_after', win.since);
    if (win.until) window.set('updated_before', win.until);

    let listBase: string;
    if (team) {
      listBase = `${base}/projects/${encodeURIComponent(String(opts.projectId))}/merge_requests?${new URLSearchParams({
        order_by: 'updated_at',
        sort: 'desc',
        state: 'all',
      })}`;
    } else {
      const userRes = await fetch(`${base}/user`, { headers });
      if (!userRes.ok) {
        throw await providerError('GitLab', userRes, { forbidden: 'Check the token has the read_api scope.' });
      }
      const user = (await userRes.json()) as { id: number };
      listBase = `${base}/merge_requests?author_id=${user.id}&state=merged`;
    }
    const windowQs = window.toString() ? `&${window.toString()}` : '';

    const limit = opts.limit ?? 100;
    const items: FetcherItem[] = [];
    let scanned = 0;
    let pagesUnreadable = 0;
    let timedOut = false;
    let exhausted = false;

    // Constant for the whole run: `page` is an offset in units of per_page, so
    // shrinking per_page on a later page moves the window backwards and re-reads
    // rows already returned. The limit is enforced by stopping, not by the page.
    const perPage = Math.min(limit, GITLAB_PAGE_MAX);
    for (let page = 1; items.length < limit; page++) {
      if (pastDeadline(deadline, clock)) {
        timedOut = true;
        break;
      }
      const url = team
        ? `${listBase}${windowQs}&per_page=${perPage}&page=${page}`
        : `${listBase}&per_page=${perPage}&page=${page}&order_by=updated_at${windowQs}`;
      const mrRes = await fetch(url, { headers });
      if (!mrRes.ok) {
        // Before ALI-828 this returned nothing and said nothing.
        pagesUnreadable += 1;
        break;
      }
      const mrs = (await mrRes.json()) as GitLabMergeRequest[];
      scanned += mrs.length;
      for (const mr of mrs) {
        if (items.length >= limit) break;
        items.push(toItem(mr));
      }
      if (mrs.length < perPage) {
        // The last page, unless the limit left one of its rows unread.
        exhausted = items.length === scanned;
        break;
      }
    }

    const skips: FetchSkip[] = [];
    if (pagesUnreadable > 0) skips.push({ kind: 'error', count: pagesUnreadable, detail: 'merge request pages the token could not read' });
    if (timedOut) skips.push({ kind: 'time_budget', count: 1, detail: `merge request read stopped at the ${opts.timeBudgetMs} ms time budget; older ones not read` });
    return {
      items,
      report: buildFetchReport(items, { platform: 'gitlab', scanned, requested: limit, skips, scope: team ? 'team' : 'yours', exhausted }),
    };
  }

  /**
   * Capture from a URL: `https://<domain>/<project path>/-/merge_requests/<iid>`, one
   * request (`GET /projects/:id/merge_requests/:iid`). Only the configured `domain`
   * (default gitlab.com) is read, so the token never goes to a host taken from the URL.
   */
  async fetchOne(url: string, opts: FetchOneOptions): Promise<FetchOneResult> {
    const domain = ((opts.domain as string | undefined) ?? 'gitlab.com').toLowerCase();
    const u = vendorUrl(url, [domain]);
    if (!u) return shapeSkip(`URL is not a merge request on ${domain}`);
    const m = /^\/([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\/-\/merge_requests\/(\d+)(?:\/.*)?$/.exec(u.pathname);
    if (!m) return shapeSkip(`URL is not a merge request on ${domain}`);
    const timeoutMs = opts.timeoutMs ?? FETCH_ONE_TIMEOUT_MS;
    try {
      // Built from the parsed project path and iid on the configured host, never the pasted URL.
      const res = await fetch(
        `https://${domain}/api/v4/projects/${encodeURIComponent(m[1]!)}/merge_requests/${m[2]}`,
        fetchOneInit({ Authorization: `Bearer ${opts.token}` }, AbortSignal.timeout(timeoutMs)),
      );
      if (!res.ok) return statusSkip('GitLab', res.status);
      const body = await readJsonCapped<GitLabMergeRequest>(res);
      return body.ok ? { item: toItem(body.value) } : tooLargeSkip('GitLab');
    } catch (err) {
      return thrownSkip('GitLab', err, timeoutMs);
    }
  }
}
