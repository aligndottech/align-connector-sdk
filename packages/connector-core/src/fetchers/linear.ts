import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchResult } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';
import { providerError } from './errors.js';

const LINEAR_GQL = 'https://api.linear.app/graphql';
const LINEAR_PAGE_MAX = 100;

/**
 * Comments per issue. Linear scores a query by the nodes it asks for and rejects a
 * single query over 10,000 points with a bare HTTP 400: a page of 100 issues carrying
 * the connection's default of 50 comments each is over that, and that is the shape
 * of the first live Linear import on 2026-09-03. 20 keeps the page well under.
 */
const LINEAR_COMMENTS_MAX = 20;

const ISSUE_FIELDS = `
  id title description url createdAt
  state { name }
  team { name }
  creator { name email }
  comments(first: ${LINEAR_COMMENTS_MAX}) { nodes { body user { name } } }
`;


interface LinearIssueNode {
  id: string;
  title: string;
  description: string | null;
  url: string;
  createdAt?: string;
  state?: { name: string };
  team?: { name: string };
  creator?: { name?: string; email?: string };
  comments?: { nodes: Array<{ body: string; user?: { name: string } }> };
}

type LinearConnection = 'assignedIssues' | 'createdIssues';

/** Page through one of the viewer's issue connections (assigned / created) up to `target`. */
async function fetchConnection(token: string, field: LinearConnection, target: number): Promise<LinearIssueNode[]> {
  const out: LinearIssueNode[] = [];
  let after: string | undefined;
  while (out.length < target) {
    const query = `query Page($first: Int!, $after: String) {
      viewer { ${field}(first: $first, after: $after, orderBy: updatedAt) {
        nodes { ${ISSUE_FIELDS} }
        pageInfo { hasNextPage endCursor }
      } }
    }`;
    const res = await fetch(LINEAR_GQL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { first: Math.min(target - out.length, LINEAR_PAGE_MAX), after } }),
    });
    // Linear answers a bad or missing key with 401 and a refused REQUEST (invalid query,
    // over the complexity limit) with 400; providerError keeps the two apart.
    if (!res.ok) throw await providerError('Linear', res);
    const json = (await res.json()) as {
      errors?: Array<{ message: string }>;
      data?: { viewer: Record<string, { nodes: LinearIssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string } }> };
    };
    if (json.errors?.length) throw new Error(json.errors[0].message);
    const conn = json.data?.viewer?.[field];
    if (!conn) break;
    out.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

/**
 * Read-only personal Linear fetcher: the caller's assigned + created issues
 * (deduped). Author = the issue creator. Paginates each connection up to `limit`.
 */
export class LinearFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
    const limit = opts.limit ?? 50;
    const [assigned, created] = await Promise.all([
      fetchConnection(opts.token, 'assignedIssues', limit),
      fetchConnection(opts.token, 'createdIssues', limit),
    ]);

    const seen = new Set<string>();
    const items: FetcherItem[] = [];
    let scanned = 0;
    for (const issue of [...assigned, ...created]) {
      if (items.length >= limit) break;
      if (seen.has(issue.id)) continue;
      seen.add(issue.id);
      scanned += 1;
      const createdAt = toIsoOrUndefined(issue.createdAt);
      const comments = (issue.comments?.nodes ?? [])
        .map((c) => `${c.user?.name ?? 'Unknown'}: ${c.body}`)
        .join('\n');
      items.push({
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
        ...(issue.creator?.name
          ? { author: { name: issue.creator.name, ...(issue.creator.email ? { email: issue.creator.email } : {}) } }
          : {}),
      });
    }

    return { items, report: { platform: 'linear', scanned, requested: limit, skips: [] } };
  }
}
