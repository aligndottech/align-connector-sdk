/**
 * One item's identity across every surface that sees it: the CLI's local graph, the
 * gateway's hosted scan, and a share from one to the other. Two readers of one format
 * must agree (code-style.md, "a lenient matcher plus a strict builder"), so both call
 * this function and both run the published table in
 * `src/__fixtures__/source-key-fixtures.json` (export `./source-key-fixtures.json`).
 *
 * Plumbing only: it says which URLs name the same item, never what the item means.
 *
 * No key (undefined) for a URL that cannot name one item: a synthetic identity Align
 * minted ({@link isSyntheticSource}), a bare host such as the Teams fetcher's
 * `https://teams.microsoft.com` fallback, or an input that does not parse. A shared
 * key there would merge every item that fell back to it.
 *
 * Rules, in order:
 *   1. Lowercase the scheme and the host. The path keeps its case (a Zoom meeting uuid
 *      and a Slack channel id are case-sensitive). Userinfo and default ports go.
 *   2. Drop trailing slashes from the path.
 *   3. Drop the fragment.
 *   4. Drop the query, except the parameters on the platform's allowlist, kept in
 *      name order so parameter order cannot split a key.
 *   5. Drop a title-derived path segment that changes when the item is renamed
 *      (Linear issue slug, Notion title prefix). Without this an edited title is a new
 *      URL, which is the twin this key exists to prevent.
 *   6. Per-platform identity: a Confluence page is keyed by `<prefix>/pages/<id>`, so its
 *      space and slug never split it (a page moved between spaces keeps its key, and the
 *      viewpage.action?pageId= form agrees). A Slack /archives/ path takes the host
 *      slack.com, whichever workspace host the permalink was built on.
 */
import { isSyntheticSource } from './utils/syntheticSource.js';


/** Query parameters that identify the item on that platform. Everything else is dropped. */
const QUERY_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  // A Confluence URL in neither page form keeps pageId, the only id it could carry.
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
  return path;
}

/** `<prefix>/pages/<id>` for a Confluence page URL in either form, else undefined. */
function confluencePagePath(u: URL): string | undefined {
  // <prefix>[/spaces/<KEY>]/pages/<id>[/<slug>]
  const m = /^(.*?)(?:\/spaces\/[^/]+)?\/pages\/(\d+)(?:\/.*)?$/.exec(u.pathname);
  if (m) return `${m[1]}/pages/${m[2]}`;
  // <prefix>/pages/viewpage.action?pageId=<id>
  const v = /^(.*?)\/pages\/viewpage\.action\/?$/.exec(u.pathname);
  const id = u.searchParams.get('pageId');
  if (v && id && /^\d+$/.test(id)) return `${v[1]}/pages/${id}`;
  return undefined;
}

/**
 * The key for one item URL. An input that does not parse as a URL is returned
 * unchanged: inventing a key for it would merge things nobody showed to be the same.
 */
export function normaliseSourceKey(platform: string, url: string): string | undefined {
  if (isSyntheticSource(url)) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }

  if (platform === 'notion') {
    // The page id is the identity; workspace and title segments both change on edit or
    // move, and notion.so/<id> (the fetcher's fallback) is the same page as the API URL.
    const last = u.pathname.replace(/\/+$/, '').split('/').pop() ?? '';
    const id = NOTION_ID.exec(last)?.[1];
    if (id) return `https://www.notion.so/${id}`;
  }

  const scheme = u.protocol.toLowerCase();
  let host = u.host.toLowerCase();
  const bare = u.pathname.replace(/\/+$/, '');
  // A bare host names no item (the Teams fallback, a site root).
  if (bare === '' && u.search === '') return undefined;

  if (platform === 'confluence') {
    const page = confluencePagePath(u);
    if (page) return `${scheme}//${host}${page}`;
  }
  if (platform === 'slack' && bare.startsWith('/archives/') && (host === 'slack.com' || host.endsWith('.slack.com'))) {
    host = 'slack.com';
  }
  const path = canonicalPath(platform, bare);

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
