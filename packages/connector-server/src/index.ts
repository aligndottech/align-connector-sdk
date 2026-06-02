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

// Testing utilities are intentionally NOT re-exported from this barrel: TestHarness
// imports `supertest` (a devDependency), so eagerly exporting it here drags supertest
// into every consumer's production import graph and crashes connectors that don't ship it.
// Import them from the dedicated subpath instead:
//   import { TestHarness } from '@aligndottech/connector-server/testing';
