/**
 * The service credential a connector presents to the Align gateway, and the error raised when
 * there is none.
 *
 * A request with no credential is never sent: an unset secret is the default deployment state
 * (the per-connector key is an optional chart secret), so "send it anyway" would mean every
 * misconfigured pod quietly makes anonymous calls.
 */

export const GATEWAY_BEARER_NOT_CONFIGURED = 'gateway_bearer_not_configured';

export class GatewayBearerNotConfiguredError extends Error {
  readonly code = GATEWAY_BEARER_NOT_CONFIGURED;

  constructor() {
    super(GATEWAY_BEARER_NOT_CONFIGURED);
    this.name = 'GatewayBearerNotConfiguredError';
  }
}

/**
 * GATEWAY_BEARER_TOKEN (the connector's own key), then SERVICE_AUTH_TOKEN (the shared one).
 * Each is trimmed on its own, so a blank first value falls through to the second instead of
 * masking it. Returns undefined when neither holds a value.
 */
export function resolveGatewayBearer(): string | undefined {
  return normaliseBearer(process.env.GATEWAY_BEARER_TOKEN) ?? normaliseBearer(process.env.SERVICE_AUTH_TOKEN);
}

/**
 * The one place a bearer is cleaned: trimmed, and a blank value counts as absent. Every path
 * that accepts a bearer (constructor, env, a caller's own) goes through it, so none of them can
 * send `Authorization: Bearer ` with nothing after it.
 */
export function normaliseBearer(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}
