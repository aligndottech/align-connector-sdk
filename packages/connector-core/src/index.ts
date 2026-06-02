/**
 * @aligndottech/connector-core
 *
 * The lightweight, open foundation for Align connectors: the read contract
 * (`ConnectorFetcher`), normalized item types, read-only fetcher implementations,
 * the gateway client, parsers, and tier definitions. No server dependencies -
 * safe to depend on from the Align CLI.
 *
 * Server-side plumbing (Express app, MCP handler, webhooks, OTel) lives in
 * `@aligndottech/connector-server`. Decision-capture engines remain proprietary.
 */

// Shared types
export * from './types/index.js';

// The connector read contract
export type {
  ConnectorFetcher,
  ConnectorFetcherOptions,
  FetcherItem,
  FetcherPage,
  DecisionAuthor,
} from './types/fetcher.js';

// Utils
export {
  getContext,
  tryGetContext,
  runWithContext,
  runWithContextAsync,
  extractBearer,
  getBearer,
  type BaseRequestContext,
} from './utils/requestContext.js';

export { UUID_REGEX, isValidUUID, assertValidUUID } from './utils/validation.js';

// Parsers
export { CommandParser, CommandHelpText } from './parsers/CommandParser.js';

// Services (light)
export {
  consumeStreamWithProgressiveUpdates,
  type MessageUpdater,
  type StreamConsumerOptions,
} from './services/StreamingResponseConsumer.js';
export {
  TelemetryClient,
  createTelemetryClient,
  type TelemetryClientConfig,
  type TelemetryEvent,
  type TelemetryCategory,
  type TelemetryPlatform,
} from './services/TelemetryClient.js';

// Tiers
export {
  CONNECTOR_TIERS,
  TIER_CAPABILITIES,
  getTierCapabilities,
  type TierCapabilities,
} from './tiers/capabilities.js';
