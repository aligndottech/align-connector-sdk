import type { FetcherItem, FetchSkip } from '../../types/fetcher.js';
import { FetcherAuthError } from '../errors.js';

/** Default budget for one capture-by-URL read: inside the capture journey, not a sync. */
export const FETCH_ONE_TIMEOUT_MS = 3_000;

export type FetchOneResult = { item?: FetcherItem; skip?: FetchSkip };

/** A URL the fetcher cannot read. Returned before any request is made. */
export function shapeSkip(connector: string, url: string, why: string): FetchOneResult {
  return { skip: { kind: 'shape', count: 1, detail: `${connector} URL not readable as one item (${why}): ${url}` } };
}

/** 401 and 403 are `auth` (the token cannot see this item); anything else is `error`. */
export function statusSkip(connector: string, status: number, words: string): FetchOneResult {
  const kind = status === 401 || status === 403 ? 'auth' : 'error';
  return { skip: { kind, count: 1, detail: `${connector} refused the item (${status})${words ? `: ${words}` : ''}` } };
}

/**
 * Run one single-item read under a timeout, turning every failure into a skip so
 * `fetchOne` never throws for a vendor problem: a timeout is `time_budget`, a refused
 * token (`FetcherAuthError`) is `auth`, anything else is `error`.
 */
export async function guardFetchOne(
  connector: string,
  timeoutMs: number | undefined,
  run: (signal: AbortSignal) => Promise<FetchOneResult>,
): Promise<FetchOneResult> {
  const ms = timeoutMs ?? FETCH_ONE_TIMEOUT_MS;
  try {
    return await run(AbortSignal.timeout(ms));
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { skip: { kind: 'time_budget', count: 1, detail: `${connector} did not answer within ${ms} ms` } };
    }
    if (e instanceof FetcherAuthError) return { skip: { kind: 'auth', count: 1, detail: e.message } };
    return { skip: { kind: 'error', count: 1, detail: `${connector} read failed: ${(e as Error)?.message ?? String(e)}` } };
  }
}
