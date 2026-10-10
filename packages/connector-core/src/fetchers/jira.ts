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
import { providerError } from './errors.js';
import { parseWindow, toIsoOrUndefined } from './util/time.js';
import { buildFetchReport, refusedRead } from './util/report.js';
import { normaliseSourceKey } from '../sourceKey.js';
import { type Clock, deadlineFrom, pastDeadline, realClock } from './util/pace.js';
import { FETCH_ONE_TIMEOUT_MS, fetchOneInit, parseUrl, readJsonCapped, shapeSkip, statusSkip, thrownSkip, tooLargeSkip, vendorUrl } from './util/single.js';

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: {
      content?: Array<{ content?: Array<{ text?: string }> }>;
    } | null;
    status?: { name: string };
    created?: string;
    updated?: string;
    reporter?: { displayName?: string; emailAddress?: string; accountId?: string };
  };
}

// Jira Cloud's /search/jql caps maxResults at 100 per request and paginates via nextPageToken.
const JIRA_PAGE_MAX = 100;

// `created` and `updated` must be asked for by name or the search API leaves them out.
const JIRA_FIELDS = ['summary', 'description', 'status', 'key', 'reporter', 'created', 'updated'];

/** A Jira project key: a letter, then letters, digits or underscores. Anything else would
 *  be JQL, not a key, so it is refused rather than quoted. */
const PROJECT_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
/** An issue key: `<PROJECT>-<number>`. */
const ISSUE_KEY = /^[A-Za-z][A-Za-z0-9_]*-\d+$/;

const DAY_MS = 86_400_000;
const jqlDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Jira-specific read options. `projects` (keys) reads everyone's issues in those projects
 * (`scope: 'team'`); without it the read stays the caller's assigned and reported issues.
 */
export interface JiraFetcherOptions extends ConnectorFetcherOptions {
  projects?: string[];
  /** Test seam for the time budget. */
  clock?: Clock;
}

function extractAdfText(adf: { content?: Array<{ content?: Array<{ text?: string }> }> } | null | undefined): string {
  if (!adf) return '';
  return (adf.content ?? [])
    .flatMap((block) => (block.content ?? []).map((inline) => inline.text ?? ''))
    .join(' ')
    .trim();
}

/**
 * The JQL for a read. A JQL date is read in the user's profile timezone
 * (https://support.atlassian.com/jira-software-cloud/docs/jql-fields/), which this
 * fetcher cannot see, so the lower bound is the day BEFORE `since` and the upper bound
 * the day after `until`: a little more than asked, never less (the consumer upserts).
 * With no window and no projects it is exactly the JQL used before S2.
 */
export function buildJiraJql(opts: { projects?: string[]; since?: string; until?: string }): string {
  const projects = opts.projects ?? [];
  for (const key of projects) {
    if (!PROJECT_KEY.test(key)) throw new Error(`Jira project key ${JSON.stringify(key)} is not a project key (letters, digits, underscore).`);
  }
  const mine = 'assignee = currentUser() OR reporter = currentUser()';
  const win = parseWindow(opts.since, opts.until);
  if (!win.ok) throw new Error(`Jira window: ${win.detail}`);
  const bounds = [
    ...(win.sinceMs === undefined ? [] : [`updated >= "${jqlDay(win.sinceMs - DAY_MS)}"`]),
    ...(win.untilMs === undefined ? [] : [`updated < "${jqlDay(win.untilMs + DAY_MS)}"`]),
  ];
  const scope = projects.length > 0 ? `project in (${projects.join(', ')})` : bounds.length > 0 ? `(${mine})` : mine;
  return `${[scope, ...bounds].join(' AND ')} ORDER BY updated DESC`;
}

/** The item mapper, shared by the list fetch and fetchOne. */
function toItem(issue: JiraIssue, browseBase: string): FetcherItem {
  const desc = extractAdfText(issue.fields.description);
  const createdAt = toIsoOrUndefined(issue.fields.created);
  const updatedAt = toIsoOrUndefined(issue.fields.updated);
  const sourceUrl = `${browseBase}/browse/${issue.key}`;
  const sourceKey = normaliseSourceKey('jira', sourceUrl);
  return {
    source_url: sourceUrl,
    platform: 'jira',
    raw_text: [`[${issue.key}] ${issue.fields.summary}`, desc, issue.fields.status?.name ? `Status: ${issue.fields.status.name}` : '']
      .filter(Boolean)
      .join('\n\n'),
    title: `[${issue.key}] ${issue.fields.summary}`,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(updatedAt ? { updated_at: updatedAt } : {}),
    ...(sourceKey ? { source_key: sourceKey } : {}),
    ...(issue.fields.reporter?.displayName
      ? {
          author: {
            name: issue.fields.reporter.displayName,
            ...(issue.fields.reporter.emailAddress ? { email: issue.fields.reporter.emailAddress } : {}),
          },
        }
      : {}),
  };
}

/** API base, auth headers and the human browse base for an OAuth (cloudId) or basic-auth (domain+email) token. */
function connection(opts: { token: string; [key: string]: unknown }) {
  const cloudId = opts.cloudId as string | undefined;
  const siteBase = opts.siteBase as string | undefined;
  const email = opts.email as string | undefined;
  const domain = opts.domain as string | undefined;
  const isOAuth = Boolean(cloudId);
  const base = isOAuth ? `https://api.atlassian.com/ex/jira/${cloudId}` : `https://${domain}`;
  const headers: Record<string, string> = isOAuth
    ? { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' }
    : {
        Authorization: `Basic ${Buffer.from(`${email}:${opts.token}`).toString('base64')}`,
        Accept: 'application/json',
      };
  const browseBase = isOAuth ? (siteBase ?? `https://api.atlassian.com/ex/jira/${cloudId}`) : base;
  return { base, headers, browseBase, siteHost: isOAuth ? (siteBase ? parseUrl(siteBase)?.hostname : undefined) : domain };
}

/**
 * Read-only Jira fetcher. OAuth (cloudId) or basic-auth (domain+email). Author = the
 * issue reporter. Paginates via nextPageToken up to `limit`.
 *
 * Personal (no `projects`): issues assigned to or reported by the caller. Team
 * (`projects`): every issue in those projects. Both bound `since`/`until` by `updated`
 * ({@link buildJiraJql}), via `POST /rest/api/3/search/jql`
 * (https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/).
 */
export class JiraFetcher implements ConnectorFetcher {
  async fetch(opts: JiraFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: JiraFetcherOptions): Promise<FetchResult> {
    const clock = opts.clock ?? realClock;
    const deadline = deadlineFrom(opts.timeBudgetMs, clock);
    const { base, headers, browseBase } = connection(opts);
    const limit = opts.limit ?? 100;
    const team = (opts.projects ?? []).length > 0;
    const win = parseWindow(opts.since, opts.until);
    if (!win.ok) return refusedRead({ platform: 'jira', requested: limit, scope: team ? 'team' : 'yours', detail: win.detail });
    const jql = buildJiraJql({
      ...(opts.projects ? { projects: opts.projects } : {}),
      ...(opts.since ? { since: opts.since } : {}),
      ...(opts.until ? { until: opts.until } : {}),
    });

    const issues: JiraIssue[] = [];
    const skips: FetchSkip[] = [];
    let nextPageToken: string | undefined;
    let stopped = false;
    let first = true;
    do {
      if (pastDeadline(deadline, clock)) {
        skips.push({ kind: 'time_budget', count: 1, detail: `issue read stopped at the ${opts.timeBudgetMs} ms time budget; older issues not read` });
        stopped = true;
        break;
      }
      const body: Record<string, unknown> = {
        jql,
        maxResults: Math.min(limit - issues.length, JIRA_PAGE_MAX),
        fields: JIRA_FIELDS,
        ...(nextPageToken ? { nextPageToken } : {}),
      };
      const res = await fetch(`${base}/rest/api/3/search/jql`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // The first page is the token's verdict (FetcherAuthError on 401); a later
        // failure keeps what was read and says what was not.
        if (first) {
          throw await providerError('Jira', res, {
            forbidden: "The token lacks Jira scopes or access. Re-auth won't help - check the Atlassian app's Jira API permissions.",
          });
        }
        skips.push({ kind: 'error', count: 1, detail: `issue search pages Jira failed to return (HTTP ${res.status})` });
        stopped = true;
        break;
      }
      first = false;
      const data = (await res.json()) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
      issues.push(...(data.issues ?? []));
      nextPageToken = data.isLast ? undefined : data.nextPageToken;
    } while (nextPageToken && issues.length < limit);

    // No continuation token left and nothing trimmed by the limit: the JQL was read to its end.
    const exhausted = !stopped && nextPageToken === undefined && issues.length <= limit;
    const items = issues.slice(0, limit).map((issue) => toItem(issue, browseBase));
    return {
      items,
      report: buildFetchReport(items, { platform: 'jira', scanned: issues.length, requested: limit, skips, scope: team ? 'team' : 'yours', exhausted }),
    };
  }

  /**
   * Capture from a URL: `<site>/browse/<KEY>`, one request (`GET /rest/api/3/issue/{key}`).
   * Only this token's site (OAuth `siteBase`, or the basic-auth `domain`) is read.
   */
  async fetchOne(url: string, opts: FetchOneOptions): Promise<FetchOneResult> {
    const { base, headers, browseBase, siteHost } = connection(opts);
    // The site this credential was issued for (OAuth siteBase, or the basic-auth domain),
    // passed in options and never inferred from the URL.
    const u = siteHost ? vendorUrl(url, [siteHost]) : undefined;
    if (!u) return shapeSkip("URL is not an issue on this token's Jira site");
    const key = /^\/browse\/([^/]+)\/?$/.exec(u.pathname)?.[1];
    if (!key || !ISSUE_KEY.test(key)) return shapeSkip('URL is not a Jira issue (expected /browse/<KEY>-<number>)');
    const timeoutMs = opts.timeoutMs ?? FETCH_ONE_TIMEOUT_MS;
    try {
      const fields = JIRA_FIELDS.filter((f) => f !== 'key').join(',');
      // Built from the validated key on the API base, never the pasted URL.
      const res = await fetch(`${base}/rest/api/3/issue/${key}?fields=${fields}`, fetchOneInit(headers, AbortSignal.timeout(timeoutMs)));
      if (!res.ok) return statusSkip('Jira', res.status);
      const body = await readJsonCapped<JiraIssue>(res);
      return body.ok ? { item: toItem(body.value, browseBase) } : tooLargeSkip('Jira');
    } catch (err) {
      return thrownSkip('Jira', err, timeoutMs);
    }
  }
}
