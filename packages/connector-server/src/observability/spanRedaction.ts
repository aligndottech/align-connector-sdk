/**
 * Span redaction (ALI-1186).
 *
 * Verbatim port of services/gateway/src/observability/spanRedaction.ts
 * (post-ALI-1190) - same REDACT_QUERY_PARAM_PATTERNS list, same
 * redactUrlCredentials, same RedactingSpanProcessor wrapping a delegate
 * SpanProcessor. See also services/brain/app/span_redaction.py, the
 * matching Python port.
 *
 * OTel auto-instrumentation can attach sensitive data to spans (auth headers,
 * cookies, SQL with inline literals, request/response bodies). When OTel is
 * exported to an external collector, that is data egress. This module scrubs
 * spans before they leave the process.
 */
import type { Attributes, AttributeValue } from '@opentelemetry/api';
import type { Context } from '@opentelemetry/api';
import type { ReadableSpan, Span, SpanProcessor } from '@opentelemetry/sdk-trace-base';

const REDACTED = '[REDACTED]';

/** Attribute keys whose VALUE is a credential/secret; the value is replaced with [REDACTED]. */
export const REDACT_VALUE_KEY_PATTERNS: RegExp[] = [
  /authorization/i,
  /\bcookie\b/i,
  /set-cookie/i,
  /token/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /api[-_]?key/i,
  /\bcredential/i,
  /private[-_]?key/i,
  /\bsession[-_]?id\b/i,
];

/** Attribute keys that may carry free-form content (incl. decision text). */
export const REDACT_CONTENT_KEY_PATTERNS: RegExp[] = [
  /\.body$/i,
  /request\.body/i,
  /response\.body/i,
  /payload/i,
  /\.text$/i,
  /decision[._]?content/i,
  /message[._]?content/i,
  /rationale/i,
];

/** The pg instrumentation puts the SQL text here; scrub inline literals. */
const SQL_STATEMENT_KEY = 'db.statement';

/**
 * Query-parameter NAMES whose value is a credential (ALI-1188). Deliberately a
 * SECOND list, not an extension of REDACT_VALUE_KEY_PATTERNS above.
 *
 * The two cannot be one list. `code` has to redact as a query parameter, because
 * `GET /oauth/callback/:key` receives the OAuth authorization code there, and it
 * must NOT redact as an attribute key, because /code/i also matches
 * `http.status_code`. One list serving both jobs makes the whole code-shaped
 * family unreachable.
 *
 * It inherits every attribute-key pattern, so a name that means "credential" in
 * one position still means it in the other, then adds the names that only ever
 * appear as query parameters. Those additions are ANCHORED: the inherited
 * patterns match dotted attribute paths and can afford to be loose, whereas a
 * loose /auth/i here would redact `oauth_version` and a loose /sig/i would redact
 * `assignee`.
 *
 * Over-redaction is the safe direction on this list. A trace that loses a
 * parameter value costs debugging time; one that keeps a live credential is an
 * egress incident.
 */
export const REDACT_QUERY_PARAM_PATTERNS: RegExp[] = [
  ...REDACT_VALUE_KEY_PATTERNS,
  // LIVE in-repo producers. Each names the code that puts the value in a query string.
  /^hmac$/i, // the Jira webhook route's `webhookSecret` binding reads the Atlassian shared
  //            secret straight off `incomingQuery.hmac`. Long-lived and replayable, so this
  //            is the highest-value name here; /secret/i already covers `secret`.
  /^code$/i, // OAuth authorization code on GET /oauth/callback/:key, exchangeable for a token
  /^state$/i, // that callback's CSRF nonce, and the cache key for the tenant/connector/user
  //             payload (auth/oauth.ts, `oauth:state:${state}`)
  // DEFENCE IN DEPTH. No code in this repo puts these in a query string today; they are
  // here because the cost is a redacted trace field and the cost of being wrong is a
  // credential in Grafana. Do not read them as evidence of a live path.
  /^code_verifier$/i, // PKCE is live (auth/directAuth.ts) but sends the verifier in a POST
  //                     body via URLSearchParams, never a query string
  /^pwd$/i, // Zoom join passcode shape; no in-repo producer, and /password/i and /passwd/i
  //           both miss the `pwd` spelling
  /^sig$/i, // Azure SAS and webhook signing; also on upstream's own default redaction list
  /(?:^|[-_])signature$/i, // `signature`, `X-Amz-Signature`; not `signature_version`
  /^auth$/i, // some APIs accept a bearer as ?auth=
  /^jwt$/i, // a bearer JWT passed directly as a query parameter
  /^assertion$/i, // SAML/OAuth JWT-bearer assertion (RFC 7523,
  //                 urn:ietf:params:oauth:grant-type:jwt-bearer)
  /^client_assertion$/i, // OAuth private_key_jwt client authentication (RFC 7523 section 2.2)
  /^signed_request$/i, // legacy platform signed_request payload (e.g. Facebook Canvas/OAuth)
];

/*
 * Attribute keys whose value carries a raw query string. Neither value is
 * URL-shaped, so redactUrlCredentials returns both byte-identical and the scrub
 * has to be reached by NAME instead (ALI-1188).
 *
 * `url.query` has TWO writers and they disagree about the leading `?`. Naming only
 * one of them is what hid this: the one named here is the one that never runs.
 *   instrumentation-undici build/src/undici.js:168 = requestUrl.search
 *       -> `?code=...&state=...`, the `?` RETAINED
 *   instrumentation-http  build/src/utils.js:650   = parsedUrl.search.slice(1)
 *       -> `code=...&state=...`, the `?` stripped
 * The http one is gated behind `semconvStability !== OLD` (utils.js:631), and
 * http.js:25 initialises it to OLD, resolved from OTEL_SEMCONV_STABILITY_OPT_IN,
 * which nothing in this repo sets. So undici is the live writer and the `?` is
 * normally present. redactQueryCarrier strips one leading `?` for that reason:
 * without it the FIRST parameter is named `?code`, and every anchored pattern
 * misses it while the unanchored inherited ones still fire, which is the shape
 * that makes a partial leak look like a clean pass.
 *
 * `http.target` is path-first, so it never carries a leading `?`:
 *   instrumentation-http utils.js:684 = parsedUrl.pathname + parsedUrl.search
 *       -> `/cb?code=...` (inbound)
 *   instrumentation-http utils.js:314 = requestOptions.path (outbound, same shape)
 */

/**
 * Value IS the query string, carrying at most ONE optional leading `?` - undici
 * includes it, instrumentation-http strips it, and redactQueryCarrier normalises
 * both. This line previously asserted there was never a `?`, which is the false
 * premise that let the first query parameter reach the exporter unredacted.
 */
const BARE_QUERY_ATTRIBUTE_KEYS = new Set(['url.query']);

/** Value is a path followed by an optional `?query`, so it never leads with `?`. */
const PATH_QUERY_ATTRIBUTE_KEYS = new Set(['http.target']);

/*
 * ALI-1190 known open boundary, shared with redactUrlCredentials below: neither
 * carrier decodes a percent-encoded parameter NAME before matching, so `%63ode=x`
 * (percent-encoded `code`) is not recognised and leaks today. Decoding it safely
 * needs a non-throwing decoder - decodeURIComponent can throw on malformed input,
 * and a span processor must never throw - which is a separate design decision, not
 * made in this file. Pinned explicitly by a test rather than left to be discovered.
 */

function keyMatches(key: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(key));
}

/**
 * Replace inline string and numeric literals in a SQL statement with `?`,
 * preserving the query shape and `$N` bind placeholders. Parameterized queries
 * (the norm) are returned unchanged.
 */
export function redactSqlStatement(sql: string): string {
  return sql
    // single-quoted string literals, including '' escapes -> '?'
    .replace(/'(?:[^']|'')*'/g, "'?'")
    // numeric literals, but not $N placeholders -> ?
    .replace(/(?<![$\w])\d+(?:\.\d+)?\b/g, '?');
}

/**
 * Redact credential-named parameters inside a raw `a=b&c=d` query string.
 *
 * The single reader of the query format in this file, so the matcher used on a
 * URL and the matcher used on a bare carrier cannot drift apart. A pair with no
 * `=` is a valueless flag and is left alone; a value that itself contains `=` is
 * redacted whole, since only the first `=` separates the name from the value.
 */
function redactQueryPairs(query: string): { value: string; changed: boolean } {
  let changed = false;
  const pairs = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      return pair;
    }
    const name = pair.slice(0, eq);
    if (!keyMatches(name, REDACT_QUERY_PARAM_PATTERNS)) {
      return pair;
    }
    changed = true;
    return `${name}=${REDACTED}`;
  });
  return { value: changed ? pairs.join('&') : query, changed };
}

/**
 * Scrub credential-named parameters out of an attribute whose value is a raw
 * query string rather than a URL (ALI-1188).
 *
 * `hasPath` says which carrier this is: `http.target` is `/path?query`, so only
 * what follows the first `?` is a query, whereas `url.query` IS the query.
 * Gating on the carrier NAME rather than sniffing the value for `=` is what
 * keeps a path segment containing an `=` from being read as a parameter.
 *
 * Pure string work, with no `new URL()` and no `decodeURIComponent`, so it cannot
 * throw inside the span processor. Returns the input byte-identical when nothing
 * matched.
 */
function redactQueryCarrier(value: string, hasPath: boolean): string {
  // A carrier value can carry a trailing `#fragment` (ALI-1190: /cb?code=X#tok).
  // Isolate it FIRST and always re-append it verbatim - redactQueryPairs only ever
  // sees the part before `#`, so a redacted query can no longer swallow the
  // fragment the way `code=AUTH#tok` -> `code=[REDACTED]` used to.
  const hashIdx = value.indexOf('#');
  const beforeHash = hashIdx === -1 ? value : value.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? '' : value.slice(hashIdx);

  if (!hasPath) {
    // Strip at most one leading `?` so the first parameter is named `code` rather
    // than `?code` under undici, then put it back. See the writer note above.
    const prefix = beforeHash.startsWith('?') ? '?' : '';
    const { value: out, changed } = redactQueryPairs(beforeHash.slice(prefix.length));
    return changed ? `${prefix}${out}${fragment}` : value;
  }
  const qIdx = beforeHash.indexOf('?');
  if (qIdx === -1) {
    return value;
  }
  const { value: out, changed } = redactQueryPairs(beforeHash.slice(qIdx + 1));
  return changed ? `${beforeHash.slice(0, qIdx + 1)}${out}${fragment}` : value;
}

/**
 * Cheap shape test for a hierarchical URL (`scheme://`). One anchored RegExp,
 * so a non-URL string fails on its first character and costs nothing further -
 * which is what makes it safe to run against every string attribute of every
 * span.
 */
const URL_SHAPE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Scrub credential material out of a URL-shaped string (ALI-1178).
 *
 * Key-based redaction cannot see this: an outbound URL built with the
 * credential inline as a query value (e.g. `...?access_token=<token>`) is
 * recorded by HTTP auto-instrumentation under `http.url` / `url.full`, and
 * neither key matches any credential pattern, so a live token was exported.
 *
 * Two carriers are handled, and both keep the parts that make a URL useful for
 * debugging (host, path, parameter names):
 *   - query parameters whose NAME matches REDACT_QUERY_PARAM_PATTERNS (ALI-1188
 *     split that out of the attribute-key list, so `?code=` is reached here too)
 *   - the userinfo component (`https://user:pass@host/`), replaced whole, since
 *     a bare userinfo is as often a token (`https://<pat>@github.com/`) as a
 *     username and there is no way to tell them apart
 *
 * NOT handled: the fragment (`#access_token=...`), and percent-encoded
 * parameter names are matched raw rather than decoded.
 *
 * This is pure string work with no `new URL()` and no `decodeURIComponent`, so
 * it cannot throw inside the span processor. A value that is not URL-shaped, or
 * a URL carrying neither carrier, is returned byte-identical.
 */
export function redactUrlCredentials(value: string): string {
  if (!URL_SHAPE.test(value)) {
    return value;
  }

  const authorityStart = value.indexOf('://') + 3;
  let authorityEnd = value.length;
  for (let i = authorityStart; i < value.length; i += 1) {
    const c = value[i];
    if (c === '/' || c === '?' || c === '#') {
      authorityEnd = i;
      break;
    }
  }

  const prefix = value.slice(0, authorityStart);
  const authority = value.slice(authorityStart, authorityEnd);
  const rest = value.slice(authorityEnd);
  let changed = false;

  // userinfo is everything before the LAST '@' in the authority.
  let outAuthority = authority;
  const at = authority.lastIndexOf('@');
  if (at !== -1) {
    outAuthority = `${REDACTED}${authority.slice(at)}`;
    changed = true;
  }

  // Split the remainder into path, query and fragment without parsing.
  const hashIdx = rest.indexOf('#');
  const beforeHash = hashIdx === -1 ? rest : rest.slice(0, hashIdx);
  const fragment = hashIdx === -1 ? '' : rest.slice(hashIdx);
  const qIdx = beforeHash.indexOf('?');

  let outRest = rest;
  if (qIdx !== -1) {
    const path = beforeHash.slice(0, qIdx);
    const { value: redactedQuery, changed: queryChanged } = redactQueryPairs(
      beforeHash.slice(qIdx + 1),
    );
    if (queryChanged) {
      outRest = `${path}?${redactedQuery}${fragment}`;
      changed = true;
    }
  }

  return changed ? `${prefix}${outAuthority}${outRest}` : value;
}

/**
 * Return a redacted copy of span attributes: credential/content values replaced
 * with [REDACTED] (keys kept), SQL literals scrubbed, everything else untouched.
 */
export function redactSpanAttributes(attributes: Attributes): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined) {
      continue;
    }
    if (keyMatches(key, REDACT_VALUE_KEY_PATTERNS) || keyMatches(key, REDACT_CONTENT_KEY_PATTERNS)) {
      out[key] = REDACTED;
      continue;
    }
    if (key === SQL_STATEMENT_KEY && typeof value === 'string') {
      out[key] = redactSqlStatement(value);
      continue;
    }
    if (typeof value === 'string') {
      // url.query/http.target normally carry a bare query (or path+query) string,
      // so the carrier-specific logic below is right for them. But
      // redactQueryCarrier has no userinfo handling at all - it was never meant
      // to see a full URL - so if either carrier ever holds one (a defensive
      // case; not the documented shape), route it through redactUrlCredentials
      // instead, exactly as the generic string branch already does at the bottom
      // of this function.
      if (BARE_QUERY_ATTRIBUTE_KEYS.has(key)) {
        out[key] = URL_SHAPE.test(value) ? redactUrlCredentials(value) : redactQueryCarrier(value, false);
        continue;
      }
      if (PATH_QUERY_ATTRIBUTE_KEYS.has(key)) {
        out[key] = URL_SHAPE.test(value) ? redactUrlCredentials(value) : redactQueryCarrier(value, true);
        continue;
      }
      out[key] = redactUrlCredentials(value);
      continue;
    }
    out[key] = value as AttributeValue;
  }
  return out;
}

/**
 * SpanProcessor that scrubs sensitive attributes on span end, then forwards to a
 * delegate processor (typically a BatchSpanProcessor) for export.
 */
export class RedactingSpanProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    // ReadableSpan.attributes is readonly by type, but the underlying object is
    // mutable here and this runs before export - overwrite in place.
    const redacted = redactSpanAttributes(span.attributes);
    const mutable = span.attributes as Record<string, AttributeValue>;
    for (const key of Object.keys(mutable)) {
      delete mutable[key];
    }
    Object.assign(mutable, redacted);
    this.delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
}
