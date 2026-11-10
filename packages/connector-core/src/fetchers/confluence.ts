import { fetch } from 'undici';
import type { ConnectorFetcher, ConnectorFetcherOptions, FetcherItem, FetchOneOptions, FetchResult, FetchSkip, FetchOneResult } from '../types/fetcher.js';
import { providerError } from './errors.js';
import { toIsoOrUndefined } from './util/time.js';
import { buildFetchReport, refusedRead } from './util/report.js';
import { budgetSpent, DescendingWindow } from './util/since.js';
import { parseWindow } from './util/time.js';
import { fetchOneInit, guardFetchOne, jsonOrThrow, parseUrl, shapeSkip, urlForDetail, vendorUrl } from './util/single.js';
import { confluencePageId, normaliseSourceKey } from '../sourceKey.js';

// Confluence v2 caps page size at 250 and paginates via _links.next (a cursor).
const CONFLUENCE_PAGE_MAX = 250;
// The v1 content search expands page bodies, which Atlassian caps at 50 results per request.
const CONFLUENCE_SEARCH_PAGE_MAX = 50;

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Confluence read options beyond the shared ones. */
export interface ConfluenceFetcherOptions extends ConnectorFetcherOptions {
  /** Space keys to read. Absent: every page the token can read. */
  spaces?: string[];
  /**
   * Page ids (digits). Narrows the read to these pages and all their descendants, newest modified
   * first, through one CQL search. Works with or without `spaces` (which then narrows it further).
   * An id the token cannot read is a skip in the report; an id that is not a page id refuses the read.
   */
  ancestors?: string[];
}

interface ConfluencePageV2 {
  title: string;
  authorId?: string;
  /** v1 content search only: the page's creator, which v2 reports as `authorId`. */
  history?: { createdBy?: { accountId?: string } };
  /** The current version's date: the page as it now stands, which is also what
   *  the hosted scan records as decided_at for Confluence. The page's own
   *  top-level createdAt is the first draft. */
  version?: { createdAt?: string; when?: string };
  body?: { storage?: { value?: string } };
  _links?: { webui?: string; base?: string };
}

/** Pull the `cursor` query param out of a Confluence `_links.next` relative URL. */
function cursorFromNext(next: string | undefined): string | undefined {
  if (!next) return undefined;
  try {
    return new URL(next, 'https://placeholder.invalid').searchParams.get('cursor') ?? undefined;
  } catch {
    return undefined;
  }
}

/** Resolve a Confluence accountId to a display name (cached). Degrades to undefined
 *  if the token lacks read:confluence-user or the lookup fails. */
function makeConfluenceUserResolver(base: string, headers: Record<string, string>, signal?: AbortSignal) {
  const cache = new Map<string, { name: string; email?: string } | null>();
  return async (accountId?: string): Promise<{ name: string; email?: string } | undefined> => {
    if (!accountId) return undefined;
    if (cache.has(accountId)) return cache.get(accountId) ?? undefined;
    try {
      const url = `${base}/rest/api/user?accountId=${encodeURIComponent(accountId)}`;
      // With a signal (fetchOne) the lookup is bounded by the read's timeout and an abort
      // is rethrown, so the read reports time_budget rather than finishing late.
      const res = signal ? await fetch(url, fetchOneInit(headers, signal)) : await fetch(url, { headers, redirect: 'manual' });
      if (!res.ok) {
        cache.set(accountId, null);
        return undefined;
      }
      const u = (signal ? await jsonOrThrow(res) : await res.json()) as { displayName?: string; publicName?: string; email?: string };
      const name = u.displayName || u.publicName;
      const resolved = name ? { name, ...(u.email ? { email: u.email } : {}) } : null;
      cache.set(accountId, resolved);
      return resolved ?? undefined;
    } catch (e) {
      if (signal?.aborted) throw e;
      cache.set(accountId, null);
      return undefined;
    }
  };
}

interface ConfluenceTarget {
  base: string;
  headers: Record<string, string>;
  humanBase: string;
}

/** OAuth (cloudId, via api.atlassian.com) or basic auth (domain + email). */
function confluenceTarget(opts: { token: string; [key: string]: unknown }): ConfluenceTarget {
  const cloudId = opts.cloudId as string | undefined;
  const siteBase = opts.siteBase as string | undefined;
  const email = opts.email as string | undefined;
  const domain = opts.domain as string | undefined;
  if (cloudId) {
    return {
      base: `https://api.atlassian.com/ex/confluence/${cloudId}/wiki`,
      headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/json' },
      humanBase: siteBase ?? `https://api.atlassian.com/ex/confluence/${cloudId}`,
    };
  }
  return {
    base: `https://${domain}/wiki`,
    headers: {
      Authorization: `Basic ${Buffer.from(`${email}:${opts.token}`).toString('base64')}`,
      Accept: 'application/json',
    },
    humanBase: `https://${domain}`,
  };
}

/**
 * The host of the site this credential was issued for, from OPTIONS only: `siteBase`
 * under OAuth, `domain` under basic auth. Never the pasted URL: a URL host would choose
 * where the stored credential is sent. Undefined when the options name no site.
 */
function configuredSiteHost(opts: { [key: string]: unknown }): string | undefined {
  if (opts.cloudId) {
    const siteBase = opts.siteBase as string | undefined;
    return siteBase ? parseUrl(siteBase)?.hostname.toLowerCase() : undefined;
  }
  const domain = opts.domain as string | undefined;
  return domain ? domain.toLowerCase() : undefined;
}

/** One page as an item. The ONE mapper for the list read and `fetchOne`. */
async function confluenceItem(
  page: ConfluencePageV2,
  linkBase: string,
  resolveUser: (accountId?: string) => Promise<{ name: string; email?: string } | undefined>,
): Promise<FetcherItem> {
  const bodyHtml = page.body?.storage?.value ?? '';
  const bodyText = stripHtml(bodyHtml).slice(0, 2000);
  const webui = page._links?.webui ?? '';
  const pageUrl = webui.startsWith('http') ? webui : `${linkBase}${webui}`;
  const author = await resolveUser(page.authorId ?? page.history?.createdBy?.accountId);
  // The current version's date is both the "as it now stands" date and the last-modified
  // time the -modified-date sort orders by, so it is created_at (unchanged) AND updated_at.
  const versionAt = toIsoOrUndefined(page.version?.createdAt ?? page.version?.when);
  const sourceKey = normaliseSourceKey('confluence', pageUrl);
  return {
    source_url: pageUrl,
    platform: 'confluence',
    raw_text: [page.title, bodyText].filter(Boolean).join('\n\n'),
    title: page.title,
    ...(versionAt ? { created_at: versionAt, updated_at: versionAt } : {}),
    ...(sourceKey ? { source_key: sourceKey } : {}),
    ...(author ? { author } : {}),
  };
}

/**
 * Read-only personal Confluence fetcher (API v2): pages the token can read.
 * OAuth (cloudId) or basic-auth (domain+email). Author = the page author.
 * Paginates via the cursor in _links.next up to `limit`.
 * With `ancestors`, reads only those pages and their descendants (see {@link ConfluenceFetcherOptions}).
 */
export class ConfluenceFetcher implements ConnectorFetcher {
  /**
   * Capture one page by URL: `GET /api/v2/pages/{id}?body-format=storage`, from the page
   * id in either page URL form. The credential's site comes from options only (`domain`
   * for basic auth, `siteBase` with `cloudId` for OAuth), and the URL must name exactly
   * that site; options naming no site, or a URL on any other host, is a `shape` skip with
   * no request. Never throws.
   */
  async fetchOne(url: string, opts: FetchOneOptions): Promise<FetchOneResult> {
    const site = configuredSiteHost(opts);
    if (!site) return shapeSkip('Confluence URL not read: the options name no Confluence site (domain, or siteBase with cloudId)');
    // The pasted URL must name exactly the configured site (https, no userinfo or port).
    // A URL naming another site, even another atlassian.net one, would otherwise read the
    // same page id on this credential's site.
    const checked = vendorUrl(url, [site]);
    const id = checked ? confluencePageId(checked.href) : undefined;
    if (!id) return shapeSkip(`Confluence URL not read as one page on ${site}: ${urlForDetail(url)}`);
    const t = confluenceTarget(opts);
    return guardFetchOne('Confluence', opts.timeoutMs, async (signal) => {
      const page = await jsonOrThrow<ConfluencePageV2>(
        await fetch(`${t.base}/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`, fetchOneInit(t.headers, signal)),
      );
      const linkBase = page._links?.base ?? `${t.humanBase}/wiki`;
      return { item: await confluenceItem(page, linkBase, makeConfluenceUserResolver(t.base, t.headers, signal)) };
    });
  }

  async fetch(opts: ConfluenceFetcherOptions): Promise<FetcherItem[]> {
    return (await this.fetchWithReport(opts)).items;
  }


  /**
   * The `ancestors` read: the named pages and all their descendants, by one CQL search
   * (`ancestor in (...) OR id in (...)`, newest modified first) so the same window, cursor and
   * limit handling as the other listings applies. v2 has `GET /pages/{id}/descendants`, but it
   * returns ids and titles only (no body, no modified time), so using it would cost a read per
   * page and could not sort or stop at `since`. The v1 search needs classic read scopes
   * (read:confluence-content.all) or the granular search:confluence scope. Each id is first checked with a bodyless
   * `GET /api/v2/pages/{id}`, because CQL answers an unreadable id with silence: an id that
   * fails that check is a skip, and is left out of the search.
   */
  private async fetchUnder(
    opts: ConfluenceFetcherOptions,
    given: string[],
    target: ConfluenceTarget,
    limit: number,
    win: { sinceMs?: number; untilMs?: number },
  ): Promise<FetchResult> {
    const { base, headers, humanBase } = target;
    const ids: string[] = [];
    const bad: string[] = [];
    for (const raw of given) {
      if (typeof raw === 'string' && /^[0-9]{1,19}$/.test(raw)) {
        if (!ids.includes(raw)) ids.push(raw);
      } else bad.push(String(raw).slice(0, 80));
    }
    const spaces = opts.spaces ? [...new Set(opts.spaces)] : [];
    for (const key of spaces) if (typeof key !== 'string' || !/^[~A-Za-z0-9_-]{1,255}$/.test(key)) bad.push(String(key).slice(0, 80));
    if (bad.length > 0) {
      return refusedRead({
        platform: 'confluence',
        requested: limit,
        scope: 'team',
        detail: `ancestors must be page ids (digits) and spaces must be space keys; not read: ${bad.join(', ')}`,
      });
    }
    const forbidden =
      'The token lacks Confluence scopes or this site has no Confluence. ' +
      "Re-auth won't help - check the Atlassian app's Confluence API permissions (or skip Confluence).";
    const startedAt = Date.now();
    const resolveUser = makeConfluenceUserResolver(base, headers);
    const skips: FetchSkip[] = [];
    const readable: string[] = [];
    const unreadable: string[] = [];
    const wanted = new Map<string, string>(); // space key -> id, when `spaces` is given
    if (spaces.length > 0) {
      let spaceCursor: string | undefined;
      do {
        const res = await fetch(
          `${base}/api/v2/spaces?keys=${spaces.map(encodeURIComponent).join(',')}&limit=250` + (spaceCursor ? `&cursor=${encodeURIComponent(spaceCursor)}` : ''),
          { headers, redirect: 'manual' },
        );
        if (!res.ok) throw await providerError('Confluence', res, { forbidden });
        const data = (await res.json()) as { results?: Array<{ id: string; key: string }>; _links?: { next?: string } };
        for (const sp of data.results ?? []) wanted.set(sp.key, sp.id);
        spaceCursor = cursorFromNext(data._links?.next);
      } while (spaceCursor);
      const missing = spaces.filter((k) => !wanted.has(k));
      if (missing.length > 0) skips.push({ kind: 'error', count: missing.length, detail: `spaces not found or not readable with this token: ${missing.join(', ')}` });
    }
    const wantedIds = new Set(wanted.values());
    const outside: string[] = [];
    for (const id of ids) {
      const res = await fetch(`${base}/api/v2/pages/${id}`, { headers, redirect: 'manual' });
      // Only "not there / not allowed" is an answer about this id; 401, 429 and 5xx are not.
      if (!res.ok && res.status !== 403 && res.status !== 404) throw await providerError('Confluence', res, { forbidden });
      if (!res.ok) {
        unreadable.push(id);
        continue;
      }
      if (spaces.length > 0) {
        const page = (await res.json()) as { spaceId?: string };
        if (!page.spaceId || !wantedIds.has(String(page.spaceId))) {
          outside.push(id);
          continue;
        }
      }
      readable.push(id);
    }
    if (outside.length > 0) {
      skips.push({ kind: 'error', count: outside.length, detail: `named pages outside the given spaces, not read: ${outside.join(', ')}` });
    }
    if (unreadable.length > 0) {
      skips.push({ kind: 'error', count: unreadable.length, detail: `pages not found or not readable with this token: ${unreadable.join(', ')}` });
    }

    const items: FetcherItem[] = [];
    const order = new DescendingWindow(win.sinceMs, win.untilMs);
    let scanned = 0;
    let cutByLimit = false;
    let unfinished = 0;
    if (readable.length > 0) {
      const list = readable.join(', ');
      const cql =
        `(ancestor in (${list}) OR id in (${list}))` +
        (spaces.length > 0 ? ` AND space in (${spaces.map((k) => `"${k}"`).join(', ')})` : '') +
        ' AND type = page ORDER BY lastmodified DESC';
      let cursor: string | undefined;
      let linkBase: string | undefined;
      let ended = false;
      while (items.length < limit) {
        const url =
          `${base}/rest/api/content/search?cql=${encodeURIComponent(cql)}&limit=${CONFLUENCE_SEARCH_PAGE_MAX}` +
          `&expand=${encodeURIComponent('body.storage,version,history')}` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        const res = await fetch(url, { headers, redirect: 'manual' });
        if (!res.ok) throw await providerError('Confluence', res, { forbidden });
        const data = (await res.json()) as { results?: ConfluencePageV2[]; _links?: { base?: string; next?: string } };
        linkBase = linkBase ?? data._links?.base ?? `${humanBase}/wiki`;
        for (const page of data.results ?? []) {
          if (items.length >= limit) {
            cutByLimit = true;
            break;
          }
          scanned += 1;
          const place = order.place(page.version?.when ?? page.version?.createdAt);
          if (place === 'stop') {
            ended = true;
            break;
          }
          if (place === 'drop') continue;
          items.push(await confluenceItem(page, linkBase, resolveUser));
        }
        if (ended || cutByLimit) break;
        cursor = cursorFromNext(data._links?.next);
        if (!cursor) {
          ended = true;
          break;
        }
        if (budgetSpent(startedAt, opts.timeBudgetMs)) {
          unfinished += 1;
          break;
        }
      }
      if (!ended && !cutByLimit && unfinished === 0 && items.length >= limit) cutByLimit = true;
    }
    skips.push(...order.skips('pages'));
    if (unfinished > 0) {
      skips.push({ kind: 'time_budget', count: unfinished, detail: `descendant search not read to the end (the ${opts.timeBudgetMs} ms time budget ran out)` });
    }
    return {
      items,
      report: buildFetchReport(items, {
        platform: 'confluence',
        scanned,
        requested: limit,
        skips,
        scope: 'team',
        untilMs: win.untilMs,
        exhausted: !cutByLimit && unfinished === 0,
      }),
    };
  }

  async fetchWithReport(opts: ConfluenceFetcherOptions): Promise<FetchResult> {
    const { base, headers, humanBase } = confluenceTarget(opts);
    const limit = opts.limit ?? 50;
    const win = parseWindow(opts.since as string | undefined, opts.until as string | undefined);
    if (!win.ok) return refusedRead({ platform: 'confluence', requested: limit, scope: 'team', detail: win.detail });
    if (opts.ancestors && opts.ancestors.length > 0) return this.fetchUnder(opts, opts.ancestors, { base, headers, humanBase }, limit, win);

    // Deduped, first occurrence kept: a key given twice is looked up and read once.
    const spaces = opts.spaces ? [...new Set(opts.spaces as string[])] : undefined;
    const startedAt = Date.now();
    const resolveUser = makeConfluenceUserResolver(base, headers);
    const forbidden =
      'The token lacks Confluence scopes or this site has no Confluence. ' +
      "Re-auth won't help - check the Atlassian app's Confluence API permissions (or skip Confluence).";

    // What to list: each selected space by id, or (no `spaces`) every page the token can
    // read. Both sorted newest-modified first: v2 has no modified-since filter, so the
    // window is a client-side stop (Decision 24; api-group-page `sort=-modified-date`).
    const listings: Array<{ key?: string; path: string }> = [];
    const skips: FetchSkip[] = [];
    if (spaces && spaces.length > 0) {
      // Paged by its cursor: a key on a later page is found, never reported missing.
      const found: Array<{ id: string; key: string }> = [];
      let spaceCursor: string | undefined;
      do {
        const res = await fetch(
          `${base}/api/v2/spaces?keys=${spaces.map(encodeURIComponent).join(',')}&limit=250` +
            (spaceCursor ? `&cursor=${encodeURIComponent(spaceCursor)}` : ''),
          { headers, redirect: 'manual' },
        );
        if (!res.ok) throw await providerError('Confluence', res, { forbidden });
        const data = (await res.json()) as { results?: Array<{ id: string; key: string }>; _links?: { next?: string } };
        found.push(...(data.results ?? []));
        spaceCursor = cursorFromNext(data._links?.next);
      } while (spaceCursor);
      const byKey = new Map(found.map((sp) => [sp.key, sp.id]));
      const missing: string[] = [];
      for (const key of spaces) {
        const id = byKey.get(key);
        if (id) listings.push({ key, path: `/api/v2/spaces/${encodeURIComponent(id)}/pages` });
        else missing.push(key);
      }
      if (missing.length > 0) {
        skips.push({ kind: 'error', count: missing.length, detail: `spaces not found or not readable with this token: ${missing.join(', ')}` });
      }
    } else {
      listings.push({ path: '/api/v2/pages' });
    }

    const items: FetcherItem[] = [];
    const perScope: Record<string, number> = {};
    const orderSkips: FetchSkip[] = [];
    let scanned = 0;
    let linkBase: string | undefined;
    let cutByLimit = false;
    let unfinished = 0; // listings the time budget left unread or part-read

    for (let li = 0; li < listings.length; li++) {
      const listing = listings[li]!;
      if (items.length >= limit) {
        cutByLimit = true;
        break;
      }
      if (li > 0 && budgetSpent(startedAt, opts.timeBudgetMs)) {
        unfinished += listings.length - li;
        break;
      }
      const order = new DescendingWindow(win.sinceMs, win.untilMs);
      let cursor: string | undefined;
      let ended = false;
      if (listing.key) perScope[listing.key] = 0;
      while (items.length < limit) {
        const url =
          `${base}${listing.path}?sort=-modified-date&limit=${CONFLUENCE_PAGE_MAX}&body-format=storage` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
        // redirect: manual everywhere: a 3xx is a non-OK answer, never a hop carrying the token.
        const res = await fetch(url, { headers, redirect: 'manual' });
        if (!res.ok) throw await providerError('Confluence', res, { forbidden });
        const data = (await res.json()) as { results?: ConfluencePageV2[]; _links?: { base?: string; next?: string } };
        linkBase = linkBase ?? data._links?.base ?? `${humanBase}/wiki`;

        for (const page of data.results ?? []) {
          if (items.length >= limit) {
            cutByLimit = true; // a page the limit left unread
            break;
          }
          scanned += 1;
          const place = order.place(page.version?.createdAt);
          if (place === 'stop') {
            ended = true;
            break;
          }
          if (place === 'drop') continue;
          items.push(await confluenceItem(page, linkBase, resolveUser));
          if (listing.key) perScope[listing.key] = (perScope[listing.key] ?? 0) + 1;
        }
        if (ended || cutByLimit) break;
        cursor = cursorFromNext(data._links?.next);
        if (!cursor) {
          ended = true;
          break;
        }
        if (budgetSpent(startedAt, opts.timeBudgetMs)) {
          unfinished += 1;
          break;
        }
      }
      orderSkips.push(...order.skips(listing.key ? `pages in ${listing.key}` : 'pages'));
      if (!ended && !cutByLimit && items.length >= limit) cutByLimit = true;
    }

    skips.push(...orderSkips);
    if (unfinished > 0) {
      skips.push({
        kind: 'time_budget',
        count: unfinished,
        detail: `${listings.length > 1 ? 'spaces' : 'listings'} not read to the end (the ${opts.timeBudgetMs} ms time budget ran out)`,
      });
    }
    return {
      items,
      report: buildFetchReport(items, {
        platform: 'confluence',
        scanned,
        requested: limit,
        skips,
        scope: 'team',
        untilMs: win.untilMs,
        exhausted: !cutByLimit && unfinished === 0,
        ...(spaces && spaces.length > 0 ? { perScope } : {}),
      }),
    };
  }
}
