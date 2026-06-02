import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem } from '../types/fetcher.js';
import { FetcherAuthError } from './errors.js';

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description?: {
      content?: Array<{ content?: Array<{ text?: string }> }>;
    } | null;
    status?: { name: string };
    reporter?: { displayName?: string; emailAddress?: string; accountId?: string };
  };
}

function extractAdfText(adf: { content?: Array<{ content?: Array<{ text?: string }> }> } | null | undefined): string {
  if (!adf) return '';
  return (adf.content ?? [])
    .flatMap((block) => (block.content ?? []).map((inline) => inline.text ?? ''))
    .join(' ')
    .trim();
}

/**
 * Read-only personal Jira fetcher: issues assigned to or reported by the caller.
 * OAuth (cloudId) or basic-auth (domain+email). Author = the issue reporter.
 */
export class JiraFetcher implements ConnectorFetcher {
  async fetch(opts: ConnectorFetcherOptions): Promise<FetcherItem[]> {
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

    const limit = opts.limit ?? 100;
    const jql = 'assignee = currentUser() OR reporter = currentUser() ORDER BY updated DESC';

    const res = await fetch(`${base}/rest/api/3/search/jql`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql, maxResults: limit, fields: ['summary', 'description', 'status', 'key', 'reporter'] }),
    });
    if (!res.ok) {
      if (res.status === 401) throw new FetcherAuthError('Jira');
      if (res.status === 403) {
        throw new Error(
          "Jira access denied (403): the token lacks Jira scopes or access. Re-auth won't help - " +
            "check the Atlassian app's Jira API permissions.",
        );
      }
      const text = await res.text();
      throw new Error(`Jira API failed (${res.status}): ${text.slice(0, 200)}`);
    }
    const data = (await res.json()) as { issues: JiraIssue[] };

    const browseBase = isOAuth ? (siteBase ?? `https://api.atlassian.com/ex/jira/${cloudId}`) : base;

    return data.issues.map((issue) => {
      const desc = extractAdfText(issue.fields.description);
      return {
        source_url: `${browseBase}/browse/${issue.key}`,
        platform: 'jira',
        raw_text: [
          `[${issue.key}] ${issue.fields.summary}`,
          desc,
          issue.fields.status?.name ? `Status: ${issue.fields.status.name}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
        title: `[${issue.key}] ${issue.fields.summary}`,
        ...(issue.fields.reporter?.displayName
          ? {
              author: {
                name: issue.fields.reporter.displayName,
                ...(issue.fields.reporter.emailAddress ? { email: issue.fields.reporter.emailAddress } : {}),
              },
            }
          : {}),
      } satisfies FetcherItem;
    });
  }
}
