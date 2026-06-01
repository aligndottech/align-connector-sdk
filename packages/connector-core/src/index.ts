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

export type {
  ConnectorFetcher,
  ConnectorFetcherOptions,
  FetcherItem,
  FetcherPage,
  DecisionAuthor,
} from './types/fetcher.js';
