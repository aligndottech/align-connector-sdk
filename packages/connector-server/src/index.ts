/**
 * @aligndottech/connector-server
 *
 * Server-side plumbing for building full Align connectors: the Express app
 * factory, MCP handler, webhook signature guard, OpenTelemetry setup, and
 * credential resolution. Depends on `@aligndottech/connector-core`.
 */

// Server
export { createConnectorApp, type ConnectorAppConfig } from './server/createConnectorApp.js';
export { createMcpHandler, type McpHandlerConfig, type McpHandler } from './server/createMcpHandler.js';

// Webhooks
export { WebhookGuard, type WebhookGuardConfig } from './webhooks/WebhookGuard.js';

// Auth
export {
  BaseCredentialResolver,
  type CredentialResolverConfig,
  type CredentialResult,
  type ResolveContext,
} from './auth/BaseCredentialResolver.js';
export {
  createRequestContext,
  type BaseRequestCtx,
  type RequestContextConfig,
  type RequestContextResult,
} from './auth/createRequestContext.js';

// Observability
export {
  setupConnectorOtel,
  createStructuredLogger,
  type ConnectorOtelConfig,
  type ConnectorOtelResult,
} from './observability/index.js';
