import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem } from '../types/fetcher.js';

interface GitLabMergeRequest {
  web_url: string;
  title: string;
  description: string | null;
  state: string;
}

/**
 * Read-only personal GitLab fetcher: the caller's merged merge requests.
 * `domain` (default gitlab.com) rides on the options index signature.
 */
export class GitLabFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
    const domain = (opts.domain as string | undefined) ?? 'gitlab.com';
    const base = `https://${domain}/api/v4`;
    const headers = { Authorization: `Bearer ${opts.token}` };

    const userRes = await fetch(`${base}/user`, { headers });
    if (!userRes.ok) {
      throw new Error(`GitLab auth failed (${userRes.status}). Check your token has 'read_api' scope.`);
    }
    const user = (await userRes.json()) as { id: number };

    const limit = opts.limit ?? 100;
    const items: FetcherItem[] = [];

    const mrRes = await fetch(
      `${base}/merge_requests?author_id=${user.id}&state=merged&per_page=${Math.min(limit, 50)}&order_by=updated_at`,
      { headers },
    );
    if (mrRes.ok) {
      const mrs = (await mrRes.json()) as GitLabMergeRequest[];
      for (const mr of mrs) {
        items.push({
          source_url: mr.web_url,
          platform: 'gitlab',
          raw_text: `${mr.title}\n\n${mr.description ?? ''}\n\nStatus: ${mr.state}`.trim(),
          title: mr.title,
        });
      }
    }

    return items.slice(0, limit);
  }
}
