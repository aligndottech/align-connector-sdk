import type { FetchOneResult, FetchSkip } from '../../types/fetcher.js';

/** Default wall-clock limit for one capture-from-URL read. */
export const FETCH_ONE_TIMEOUT_MS = 3_000;

/** A URL this fetcher does not read. Made before any request. */
export function shapeSkip(detail: string): FetchOneResult {
  return { skip: { kind: 'shape', count: 1, detail } };
}

/** 401/403 is the token; everything else (404 included) is an error. */
export function statusSkip(name: string, status: number): FetchOneResult {
  const skip: FetchSkip =
    status === 401 || status === 403
      ? { kind: 'auth', count: 1, detail: `item ${name} refused to this token (HTTP ${status})` }
      : { kind: 'error', count: 1, detail: `item ${name} could not return (HTTP ${status})` };
  return { skip };
}

/** A thrown fetch: a timeout is time_budget, anything else an error. Never rethrown. */
export function thrownSkip(name: string, err: unknown, timeoutMs: number): FetchOneResult {
  const errName = (err as { name?: string } | null)?.name;
  if (errName === 'TimeoutError' || errName === 'AbortError') {
    return { skip: { kind: 'time_budget', count: 1, detail: `item not read: ${name} did not answer within ${timeoutMs} ms` } };
  }
  return { skip: { kind: 'error', count: 1, detail: `item not read: the ${name} request failed (${(err as Error)?.message ?? 'unknown error'})` } };
}

/** Parse a URL, or undefined. */
export function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}
