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
  // The error's message is NOT echoed: a transport error can quote the request, and the
  // request carries the stored credential. The error's class name is enough to act on.
  return { skip: { kind: 'error', count: 1, detail: `item not read: the ${name} request failed (${errName ?? 'error'})` } };
}

/** Largest single-item response read, in bytes. A PR or issue is a few kB; anything
 *  near this is not the item. */
export const FETCH_ONE_MAX_BODY_BYTES = 2_000_000;

/**
 * The URL a person or agent pasted, accepted only when it names one of `hosts` exactly,
 * else undefined. fetchOne sends a STORED credential, so it must never reach a host taken
 * from URL text. Compared on the PARSED hostname, never a substring of the raw string, and
 * refused outright: any whitespace or backslash in the raw text, a scheme other than
 * https, userinfo (`https://site@evil.com`, and `https://evil@site` too), an explicit
 * port, or a hostname not in `hosts` (which also refuses IP literals, a trailing dot and
 * every lookalike such as `site.evil.com`). The caller then builds its request from ids
 * parsed out of the path, on the vendor's fixed API host, never by forwarding this URL.
 */
export function vendorUrl(raw: string, hosts: readonly string[]): URL | undefined {
  if (typeof raw !== 'string' || /[\s\\]/.test(raw)) return undefined;
  const u = parseUrl(raw);
  if (!u) return undefined;
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return undefined;
  const host = u.hostname.toLowerCase();
  return hosts.some((h) => h.toLowerCase() === host) ? u : undefined;
}

/**
 * Request options for a fetchOne call: one timeout signal for the whole read (default
 * 3 s, made once by the caller with `AbortSignal.timeout`), and
 * `redirect: 'manual'` so the credential never follows a redirect to another host. A 3xx
 * then arrives as a non-OK response and becomes an error skip.
 */
export function fetchOneInit(headers: Record<string, string>, signal: AbortSignal) {
  return { headers, signal, redirect: 'manual' as const };
}

/**
 * The JSON body, or `{ ok: false }` when it is larger than {@link FETCH_ONE_MAX_BODY_BYTES}.
 * The limit is in BYTES: a declared `content-length` over it is refused without reading,
 * and a stream is read chunk by chunk and cancelled at the cap, so an oversized answer is
 * never held in memory. (UTF-16 length undercounts: two-byte text of 1.2M characters is
 * 2.4M bytes.) A response with no stream falls back to `text()`.
 */
export async function readJsonCapped<T>(res: {
  text(): Promise<string>;
  headers?: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
}): Promise<{ ok: true; value: T } | { ok: false }> {
  const declared = Number(res.headers?.get?.('content-length') ?? NaN);
  if (!Number.isNaN(declared) && declared > FETCH_ONE_MAX_BODY_BYTES) return { ok: false };
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > FETCH_ONE_MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false };
      }
      chunks.push(value);
    }
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as T };
  }
  const text = await res.text();
  if (Buffer.byteLength(text, 'utf8') > FETCH_ONE_MAX_BODY_BYTES) return { ok: false };
  return { ok: true, value: JSON.parse(text) as T };
}

/**
 * Replace anything credential-shaped in vendor text: a vendor token prefix (`lin_api_`,
 * `ghp_`, ...), a `Bearer` or `Basic` value, the value of `token=`/`key=`/`secret=`/
 * `password=` of ANY length, a base64 run that carries `+`, `=` padding or mixed-case `/`,
 * and any other 20+ character key-shaped run. A vendor can echo part of the request, and
 * the request carries the stored credential.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(?:lin_api_|lin_oauth_|ghp_|gho_|ghs_|github_pat_|glpat-|xox[a-z]-)[A-Za-z0-9_-]*/gi, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [redacted]')
    .replace(/\b(token|key|secret|password|passwd|api[_-]?key|access[_-]?token)(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s&"',;]+)/gi, '$1$2[redacted]')
    .replace(/[A-Za-z0-9+/]{12,}={0,2}/g, (run) => {
      const padded = run.endsWith('=');
      const mixed = /[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run);
      return padded || run.includes('+') || (run.includes('/') && mixed) ? '[redacted]' : run;
    })
    .replace(/[A-Za-z0-9_-]{20,}/g, '[redacted]');
}

/** A vendor's error message, safe for a skip or an Error: {@link redactSecrets}, then cut
 *  to 120 characters in all, ellipsis included. */
export function vendorMessage(message: unknown): string {
  const text = typeof message === 'string' ? message : '';
  const clean = redactSecrets(text).replace(/\s+/g, ' ').trim();
  return clean.length > 120 ? `${clean.slice(0, 117)}...` : clean;
}

export function tooLargeSkip(name: string): FetchOneResult {
  return { skip: { kind: 'error', count: 1, detail: `item not read: the ${name} response was too large to be one item` } };
}

/** Parse a URL, or undefined. */
export function parseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}
