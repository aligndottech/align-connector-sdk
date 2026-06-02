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

// Canonical read-only fetchers (one implementation per provider, shared by the
// CLI personal import and the paid discover scan).
export {
  FETCHERS,
  GitHubFetcher,
  GitLabFetcher,
  GitFetcher,
  buildCommitUrl,
  formatCommitAsText,
  type GitCommitSource,
  type GitCommit,
} from './fetchers/index.js';

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
  GatewayClient,
  type GatewayClientConfig,
  type JiraCredentials,
} from './services/GatewayClient.js';
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

// Decision-flow interfaces (contributor-implemented; engine stays proprietary)
export {
  NoOpDecisionFlowStateRepository,
  type PlatformMessage,
  type DecisionAlertFormatter,
  type MessagePoster,
  type DecisionFlowConversationState,
  type DecisionFlowCommand,
  type IDecisionFlowStateRepository,
  type IMultiDecisionStateRepository,
  type IConversationStateRepository,
  type IDecisionFlowService,
  type IMultiDecisionFlowService,
  type IConversationFlowService,
  type MultiDecisionFlowResult,
  type ConnectorTier,
  type ConnectorCapabilities,
  type TranscriptAnalysisResult,
  type DecisionCaptureResult,
} from './types/flow.js';

// Testing utilities
export { MockGatewayClient } from './testing/MockGatewayClient.js';
export { fixtures } from './testing/fixtures.js';
