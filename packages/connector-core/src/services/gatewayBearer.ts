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
  return process.env.GATEWAY_BEARER_TOKEN?.trim() || process.env.SERVICE_AUTH_TOKEN?.trim() || undefined;
}
