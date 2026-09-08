/**
 * Display guard: an identity Align minted is not a place anyone can open.
 *
 * When a decision graph scan cannot verify where a decision was made, the item gets a
 * synthetic identity instead of a real source_url - `align://claimed/<hash>` when the model
 * claimed a source, `align://unsourced/<hash>` when it claimed nothing. `align://` is a
 * syntactically valid URI, so anything that renders `source_url` as a link, a comment, a
 * check-run URL, or an ADF/Markdown reference will silently point nowhere unless it is
 * filtered first.
 *
 * ALI-922: promoted here from align-stack, which had grown SIX independent copies of this
 * (the gateway's minting site, `services/gateway/src/discover/suggestionHelpers.ts`'s
 * `claimedIdentityFor`, plus five readers: mcp-align, the UI, and three connectors -
 * mcp-teams, mcp-github, mcp-jira - each pinned by its own test reading the minting site
 * directly). Every connector already depends on `@aligndottech/connector-core`, and
 * `RelatedDecision` (this package's decision type, in `types/index.ts`) carries the same
 * `source_url` field these functions guard - so this is the shared home going forward. A
 * SEVENTH consumer (align-cli, ALI-923) could not take this dependency at the time it needed
 * the same logic - it is a plain npm CLI in a different repo/ecosystem, not a connector - so
 * it carries its own copy in `src/lib/decision-links.ts` rather than a connector-core import.
 */
export const SYNTHETIC_SOURCE_PREFIXES: readonly string[] = [
  'align://claimed/',
  'align://unsourced/',
];

/** True when this source_url is an identity Align minted, not a place anyone can open. */
export function isSyntheticSource(sourceUrl: string | undefined | null): boolean {
  if (typeof sourceUrl !== 'string') return false;
  // startsWith, never includes: a real page may carry the text in its path.
  return SYNTHETIC_SOURCE_PREFIXES.some((prefix) => sourceUrl.startsWith(prefix));
}

/**
 * The source url, only when it is somewhere a person can go. `undefined` otherwise, so every
 * caller's `?? fallbackUrl` reaches a real page (an Align decision link, a details view)
 * instead of a dead link built from a synthetic identity.
 */
export function navigableSourceUrl(sourceUrl: string | undefined | null): string | undefined {
  if (typeof sourceUrl !== 'string' || sourceUrl.length === 0) return undefined;
  return isSyntheticSource(sourceUrl) ? undefined : sourceUrl;
}
