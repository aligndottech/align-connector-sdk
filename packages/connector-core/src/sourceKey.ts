/**
 * One item's identity across every surface that sees it: the CLI's local graph, the
 * gateway's hosted scan, and a share from one to the other. Two readers of one format
 * must agree (code-style.md, "a lenient matcher plus a strict builder"), so both call
 * this function and both run the published table in
 * `src/__fixtures__/source-key-fixtures.json` (export `./source-key-fixtures.json`).
 *
 * Plumbing only: it says which URLs name the same item, never what the item means.
 *
 * No key (undefined) for a URL that cannot name one item, or cannot name it the same
 * way the site URL does: a synthetic identity Align minted ({@link isSyntheticSource}),
 * a bare host with or without a query (the Teams fetcher's `https://teams.microsoft.com`
 * fallback), an Atlassian OAuth fallback URL (`api.atlassian.com/ex/<product>/<cloudId>`,
 * which carries a cloudId where the site URL carries the site host, and the URL alone
 * cannot map one to the other), or an input that does not parse. A shared or mismatched
 * key there would merge unrelated items or split one item in two.
 *
 * Rules, in order:
 *   1. Lowercase the scheme and the host. The path keeps its case (a Zoom meeting uuid
 *      and a Slack channel id are case-sensitive), except owner and repo on github.com,
 *      which GitHub treats case-insensitively. Userinfo and default ports go.
 *   2. Drop trailing slashes from the path, and uppercase percent-escape hex (%2f -> %2F).
 *   3. Drop the fragment.
 *   4. Drop the query, except the parameters on the platform's allowlist, kept in
 *      name order so parameter order cannot split a key.
 *   5. Drop a title-derived path segment that changes when the item is renamed
 *      (Linear issue slug, Notion title prefix). Without this an edited title is a new
 *      URL, which is the twin this key exists to prevent.
 *   6. Per-platform identity: a Confluence page is keyed by `<prefix>/pages/<id>`, so its
 *      space and slug never split it (a page moved between spaces keeps its key, and the
 *      viewpage.action?pageId= form agrees). A Slack /archives/ path takes the host
 *      slack.com, whichever workspace host the permalink was built on. A Notion URL is
 *      keyed by its page id, from a `?p=` peek parameter first, else the last segment.
 *
 * By design, a URL pointing at a COMMENT maps to its item's key: GitHub
 * `#issuecomment-N` and Linear `#comment-x` go with the fragment (rule 3), Jira
 * `?focusedCommentId=` with the query (rule 4). Comments belong to their item, and the
 * item is the unit a decision row is keyed on.
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
const NOTION_BARE_ID = /^[0-9a-f]{32}$/;

function canonicalPath(platform: string, host: string, path: string): string {
  let out = path;
  if (platform === 'linear') {
    // /<workspace>/issue/<KEY>/<title-slug> -> /<workspace>/issue/<KEY>
    const m = /^(\/[^/]+\/issue\/[^/]+)\/[^/]*$/.exec(out);
    if (m) out = m[1]!;
  }
  if (host === 'github.com') {
    // /<owner>/<repo>/... : GitHub resolves owner and repo case-insensitively. The rest
    // (a commit sha, a branch name) keeps its case.
    out = out.replace(/^(\/[^/]+)(\/[^/]+)?/, (_all, owner: string, repo?: string) => (owner + (repo ?? '')).toLowerCase());
  }
  return out.replace(/%[0-9a-fA-F]{2}/g, (esc) => esc.toUpperCase());
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

/** The page id a Confluence page URL names, in either page form, else undefined. The same
 *  reader the key uses, so `fetchOne` cannot accept a URL the key would reject. */
export function confluencePageId(url: string): string | undefined {
  try {
    return confluencePagePath(new URL(url))?.split('/').pop();
  } catch {
    return undefined;
  }
}

/**
 * The key for one item URL, or undefined when the URL cannot name one item (see the
 * module comment): a synthetic identity, a bare host, an Atlassian OAuth fallback URL,
 * or an input that does not parse. Never an invented key.
 */
export function normaliseSourceKey(platform: string, url: string): string | undefined {
  if (isSyntheticSource(url)) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }

  const scheme = u.protocol.toLowerCase();
  let host = u.host.toLowerCase();
  const bare = u.pathname.replace(/\/+$/, '');

  if (platform === 'notion') {
    // The page id is the identity; workspace and title segments both change on edit or
    // move, and notion.so/<id> (the fetcher's fallback) is the same page as the API URL.
    // A database view with ?p=<id> is a peek at that page, not the database.
    const peek = u.searchParams.get('p');
    const id = peek && NOTION_BARE_ID.test(peek) ? peek : NOTION_ID.exec(bare.split('/').pop() ?? '')?.[1];
    if (id) return `https://www.notion.so/${id}`;
  }

  // A bare host names no item (the Teams fallback, a site root), whatever its query says.
  if (bare === '') return undefined;
  // The OAuth fallback carries a cloudId instead of the site host: it can never match the
  // site URL of the same item, so it gets no key rather than a second one.
  if (host === 'api.atlassian.com' && bare.startsWith('/ex/')) return undefined;

  if (platform === 'confluence') {
    const page = confluencePagePath(u);
    if (page) return `${scheme}//${host}${page}`;
  }
  if (platform === 'slack' && bare.startsWith('/archives/') && (host === 'slack.com' || host.endsWith('.slack.com'))) {
    host = 'slack.com';
  }
  const path = canonicalPath(platform, host, bare);

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
