/**
 * @aligndottech/connector-server
 *
 * Server-side plumbing for building full Align connectors: the Express app
 * factory, MCP handler, webhook signature guard, OpenTelemetry setup, and a test
 * harness. Depends on `@aligndottech/connector-core`.
 *
 * Modules are moved here from the legacy `@align/connector-sdk` during ALI-124
 * (Phase 1). This placeholder keeps the package buildable while that move lands.
 */

export const CONNECTOR_SERVER_PACKAGE = '@aligndottech/connector-server';
