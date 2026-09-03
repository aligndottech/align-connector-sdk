import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchResult, FetchSkip } from '../types/fetcher.js';
import { toIsoOrUndefined } from './util/time.js';
import { providerError } from './errors.js';

interface GitLabMergeRequest {
  web_url: string;
  title: string;
  description: string | null;
  state: string;
  created_at?: string;
}

// GitLab's own per-page maximum. Before ALI-828 the read was one page of at
// most 50, a cap nobody had chosen, whatever the caller asked for.
const GITLAB_PAGE_MAX = 100;

/**
 * Read-only personal GitLab fetcher: the caller's merged merge requests, paged
 * by page number up to `limit` (a page shorter than requested is the last).
 * `domain` (default gitlab.com) rides on the options index signature.
 */
export class GitLabFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }

  async fetchWithReport(opts: ConnectorFetcherOptions): Promise<FetchResult> {
    const domain = (opts.domain as string | undefined) ?? 'gitlab.com';
    const base = `https://${domain}/api/v4`;
    const headers = { Authorization: `Bearer ${opts.token}` };

    const userRes = await fetch(`${base}/user`, { headers });
    if (!userRes.ok) {
      throw await providerError('GitLab', userRes, { forbidden: 'Check the token has the read_api scope.' });
    }
    const user = (await userRes.json()) as { id: number };

    const limit = opts.limit ?? 100;
    const items: FetcherItem[] = [];
    let scanned = 0;
    let pagesUnreadable = 0;

    // Constant for the whole run: `page` is an offset in units of per_page, so
    // shrinking per_page on a later page moves the window backwards and re-reads
    // rows already returned. The limit is enforced by stopping, not by the page.
    const perPage = Math.min(limit, GITLAB_PAGE_MAX);
    for (let page = 1; items.length < limit; page++) {
      const mrRes = await fetch(
        `${base}/merge_requests?author_id=${user.id}&state=merged&per_page=${perPage}&page=${page}&order_by=updated_at`,
        { headers },
      );
      if (!mrRes.ok) {
        // Before ALI-828 this returned nothing and said nothing.
        pagesUnreadable += 1;
        break;
      }
      const mrs = (await mrRes.json()) as GitLabMergeRequest[];
      scanned += mrs.length;
      for (const mr of mrs) {
        if (items.length >= limit) break;
        const createdAt = toIsoOrUndefined(mr.created_at);
        items.push({
          source_url: mr.web_url,
          platform: 'gitlab',
          raw_text: `${mr.title}\n\n${mr.description ?? ''}\n\nStatus: ${mr.state}`.trim(),
          title: mr.title,
          ...(createdAt ? { created_at: createdAt } : {}),
        });
      }
      if (mrs.length < perPage) break; // last page
    }

    const skips: FetchSkip[] = [];
    if (pagesUnreadable > 0) skips.push({ kind: 'error', count: pagesUnreadable, detail: 'merge request pages the token could not read' });
    return { items, report: { platform: 'gitlab', scanned, requested: limit, skips } };
  }
}
