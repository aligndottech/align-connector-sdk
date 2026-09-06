import { timingSafeEqual } from 'node:crypto';

/**
 * Fail-closed shared-secret check for connectors whose upstream does not sign the webhook
 * body at all (a platform that only supports a static shared secret rather than an HMAC).
 *
 * This is deliberately NOT a signature check - see `WebhookGuard.verifySignature` for HMAC
 * verification. Use this when the platform's only mechanism is "send back the secret you
 * were given", which cannot be strengthened into a signature without the platform's
 * cooperation.
 *
 * The important property this enforces: an UNCONFIGURED secret is treated as a rejection,
 * never as "skip verification". A naive `if (configuredSecret) { compare }` shape verifies
 * only when someone remembered to set the secret, and an unset secret is normally the
 * *default* deployment state, not an edge case - so that shape fails open by default. This
 * helper fails closed by default instead: no secret configured means every delivery is
 * rejected until one is set.
 */

export type VerifyWebhookSecretOutcome =
  | { ok: true }
  | { ok: false; reason: 'missing_secret' | 'bad_secret' };

/** Constant-time string comparison. Returns false on any length mismatch or error. */
function secureCompare(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    if (bufA.length !== bufB.length) {
      return false;
    }
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Is a usable secret configured at all? The single source of the "blank counts as unset"
 * rule that `verifyWebhookSecret` applies below, so a startup warning or a health endpoint
 * built on this cannot disagree with what verification actually enforces - see
 * `realtimeHealth` for that pairing.
 */
export function isWebhookSecretConfigured(configuredSecret: string | undefined): boolean {
  return Boolean(configuredSecret?.trim());
}

/**
 * A ready-to-return health payload describing whether a webhook route backed by this
 * verifier would actually accept a delivery right now. Exists as a function, not an inline
 * ternary at the call site, so a test can pin it directly - inline, a flipped live/dark
 * reads as correct to a casual review and no test would catch it.
 */
export function realtimeHealth(configuredSecret: string | undefined):
  | { ok: true; realtime: 'live' }
  | { ok: true; realtime: 'dark'; reason: 'missing_secret' } {
  return isWebhookSecretConfigured(configuredSecret)
    ? { ok: true, realtime: 'live' }
    : { ok: true, realtime: 'dark', reason: 'missing_secret' };
}

/**
 * @param providedSecret the secret value the caller supplied (a header, a query param -
 *   this helper is transport-agnostic and takes it as an opaque string either way)
 * @param configuredSecret the deployment's expected secret
 * @returns ok:true only when a secret is configured AND the caller's value matches it.
 *   A blank/whitespace configured secret counts as unset - a secret mounted as an empty
 *   string is a real deployment state (an empty Kubernetes Secret value, an unset env var
 *   defaulting to `''`), and treating it as configured would re-open the fail-open hole this
 *   helper exists to close.
 */
export function verifyWebhookSecret(
  providedSecret: string | undefined,
  configuredSecret: string | undefined,
): VerifyWebhookSecretOutcome {
  const expected = configuredSecret?.trim();
  if (!expected) {
    return { ok: false, reason: 'missing_secret' };
  }
  if (!providedSecret || !secureCompare(providedSecret, expected)) {
    return { ok: false, reason: 'bad_secret' };
  }
  return { ok: true };
}
