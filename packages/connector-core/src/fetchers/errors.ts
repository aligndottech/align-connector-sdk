/**
 * Thrown by a fetcher when the provider answered 401: the credential itself was refused,
 * so re-authenticating (or pasting a fresh token) would help. Callers (the CLI) catch this
 * by type to offer a reconnect and to forget a saved token that is dead, vs. a generic
 * Error (403 / lacking scopes / a rejected request) where a new token won't help.
 *
 * `detail` is the provider's own words, read from the response body, so the message
 * says WHY rather than guessing.
 */
export class FetcherAuthError extends Error {
  constructor(
    public readonly connector: string,
    detail?: string,
  ) {
    super(
      `${connector} authentication failed (401)${detail ? `: ${sentence(detail)}` : '.'} ` +
        'Check your token: it may be invalid, expired or revoked.',
    );
    this.name = 'FetcherAuthError';
  }
}

/** The subset of a fetch Response a refused request needs. Both readers optional: some
 *  test doubles offer only `json()`. */
export interface RefusedResponse {
  status: number;
  text?(): Promise<string>;
  json?(): Promise<unknown>;
}

const MAX_DETAIL = 200;

function sentence(s: string): string {
  return s.endsWith('.') ? s : `${s}.`;
}

/** The message inside whichever envelope the provider uses, or '' when there is none. */
function wordsOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  const o = v as Record<string, unknown>;
  // GraphQL (Linear) and REST APIs that list several problems.
  if (Array.isArray(o.errors)) {
    const msgs = o.errors
      .map((e) => (e && typeof e === 'object' ? (e as { message?: unknown }).message : e))
      .filter((m): m is string => typeof m === 'string' && m.length > 0);
    if (msgs.length) return msgs.join('; ');
  }
  // Atlassian.
  if (Array.isArray(o.errorMessages)) {
    const msgs = o.errorMessages.filter((m): m is string => typeof m === 'string' && m.length > 0);
    if (msgs.length) return msgs.join('; ');
  }
  // GitHub, GitLab, Notion, Zoom.
  if (typeof o.message === 'string' && o.message) return o.message;
  // Microsoft Graph: { error: { code, message } }.
  if (o.error && typeof o.error === 'object') {
    const m = (o.error as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  // OAuth-style { error: 'invalid_token', error_description }.
  if (typeof o.error_description === 'string' && o.error_description) return o.error_description;
  if (typeof o.error === 'string' && o.error) return o.error;
  return '';
}

/** The body as text, reading `text()` first and `json()` when text is absent or empty. A
 *  real Response can be read once, so the json fallback after an empty text() simply
 *  fails and yields '' there; it exists for test doubles that carry the payload in json(). */
export async function refusedBody(res: RefusedResponse): Promise<string> {
  let raw = '';
  try {
    if (typeof res.text === 'function') raw = (await res.text()) ?? '';
  } catch {
    raw = '';
  }
  if (!raw.trim() && typeof res.json === 'function') {
    try {
      const j = await res.json();
      raw = j == null ? '' : typeof j === 'string' ? j : JSON.stringify(j);
    } catch {
      raw = '';
    }
  }
  return raw;
}

/**
 * The provider's own words for a refused request, or '' when it gave none.
 *
 * Reads the body once, pulls the message out of the envelope the provider uses, and
 * falls back to the raw body. Capped at 200 characters so an HTML error page or a stack
 * trace does not become the error message. Never the string "null": an empty body is
 * silence, not a word.
 */
export async function providerErrorText(res: RefusedResponse): Promise<string> {
  let raw = await refusedBody(res);
  raw = (raw ?? '').trim();
  if (!raw || raw === 'null') return '';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw.slice(0, MAX_DETAIL);
  }
  return (wordsOf(parsed) || raw).slice(0, MAX_DETAIL);
}

/**
 * The error a fetcher throws for a non-OK provider response. One rule for every fetcher:
 *
 *   401            -> FetcherAuthError with the provider's words (the token was refused)
 *   403            -> Error with the provider's words, then the connector's own scope hint
 *   anything else  -> Error with the provider's words and nothing else
 *
 * The token hint lives ONLY on 401. Until 2026-09-03 four fetchers said "check your token"
 * for any non-OK status, so a Linear 400 (a request Linear rejected: over its complexity
 * limit) sent a user chasing a token that was fine. A 400 is the provider refusing the
 * REQUEST; a new key changes nothing, and saying so is the whole value of this function.
 */
export async function providerError(
  connector: string,
  res: RefusedResponse,
  opts: { forbidden?: string } = {},
): Promise<Error> {
  const detail = await providerErrorText(res);
  if (res.status === 401) return new FetcherAuthError(connector, detail);
  const hint = res.status === 403 && opts.forbidden ? ` ${opts.forbidden}` : '';
  return new Error(`${connector} API failed (${res.status})${detail ? `: ${sentence(detail)}` : '.'}${hint}`);
}
