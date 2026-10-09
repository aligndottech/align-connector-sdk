/**
 * One item's identity across every surface that sees it: the CLI's local graph, the
 * gateway's hosted scan, and a share from one to the other. Two readers of one format
 * must agree (code-style.md, "a lenient matcher plus a strict builder"), so both call
 * this function and both run the published table in
 * `src/__fixtures__/source-key-fixtures.json` (export `./source-key-fixtures.json`).
 *
 * Plumbing only: it says which URLs name the same item, never what the item means.
 *
 * Rules, in order:
 *   1. Lowercase the scheme and the host. The path keeps its case (a Zoom meeting uuid
 *      and a Slack channel id are case-sensitive). Userinfo and default ports go.
 *   2. Drop trailing slashes from the path.
 *   3. Drop the fragment.
 *   4. Drop the query, except the parameters on the platform's allowlist, kept in
 *      name order so parameter order cannot split a key.
 *   5. Drop a title-derived path segment that changes when the item is renamed
 *      (Linear issue slug, Confluence page slug, Notion title prefix). Without this an
 *      edited title is a new URL, which is the twin this key exists to prevent.
 */

/** Query parameters that identify the item on that platform. Everything else is dropped. */
const QUERY_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  // /wiki/pages/viewpage.action?pageId=123: the id lives only in the query.
  confluence: ['pageId'],
  // A reply permalink names its thread in the query.
  slack: ['thread_ts'],
};

// A Notion page id: 32 lowercase hex characters ending the last path segment.
const NOTION_ID = /(?:^|-)([0-9a-f]{32})$/;

function canonicalPath(platform: string, path: string): string {
  if (platform === 'linear') {
    // /<workspace>/issue/<KEY>/<title-slug> -> /<workspace>/issue/<KEY>
    const m = /^(\/[^/]+\/issue\/[^/]+)\/[^/]*$/.exec(path);
    if (m) return m[1]!;
  }
  if (platform === 'confluence') {
    // .../pages/<id>/<title-slug> -> .../pages/<id>
    const m = /^(.*\/pages\/\d+)\/[^/]*$/.exec(path);
    if (m) return m[1]!;
  }
  return path;
}

/**
 * The key for one item URL. An input that does not parse as a URL is returned
 * unchanged: inventing a key for it would merge things nobody showed to be the same.
 */
export function normaliseSourceKey(platform: string, url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }

  if (platform === 'notion') {
    // The page id is the identity; workspace and title segments both change on edit or
    // move, and notion.so/<id> (the fetcher's fallback) is the same page as the API URL.
    const last = u.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    const id = NOTION_ID.exec(last)?.[1];
    if (id) return `https://www.notion.so/${id}`;
  }

  const scheme = u.protocol.toLowerCase();
  const host = u.host.toLowerCase();
  const path = canonicalPath(platform, u.pathname.replace(/\/+$/, ''));

  const allowed = QUERY_ALLOWLIST[platform] ?? [];
  const kept: Array<[string, string]> = [];
  for (const [name, value] of u.searchParams) {
    if (allowed.includes(name)) kept.push([name, value]);
  }
  // Code-unit order, never locale order (latent-vs-deterministic.md).
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  kept.sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  const query = kept.length ? `?${new URLSearchParams(kept).toString()}` : '';

  return `${scheme}//${host}${path}${query}`;
}
