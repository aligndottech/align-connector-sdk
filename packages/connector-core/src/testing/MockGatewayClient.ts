import { randomUUID } from 'node:crypto';
import type { DecisionSearchOptions, DecisionSearchResponse } from '../types/index.js';

interface IngestCall {
  tenantId: string;
  payload: Record<string, unknown>;
}

interface SearchCall {
  tenantId: string;
  query: string;
  options?: DecisionSearchOptions;
}

interface CredentialCall {
  tenantId: string;
  platform: string;
}

interface CallLog {
  ingest: IngestCall[];
  ingestBatch: IngestCall[];
  credentials: CredentialCall[];
  searchDecisions: SearchCall[];
}

type IngestHandler = (tenantId: string, payload: Record<string, unknown>) => Record<string, unknown>;
type CredentialHandler = (tenantId: string) => Record<string, string>;

/**
 * Mock implementation of GatewayClient for unit testing connectors.
 * Tracks all calls for assertions and supports configurable responses.
 */
export class MockGatewayClient {
  calls: CallLog = { ingest: [], ingestBatch: [], credentials: [], searchDecisions: [] };

  private ingestHandler: IngestHandler = () => ({
    id: randomUUID(),
    title: 'Mock Decision',
    status: 'active',
  });

  private ingestBatchHandler: IngestHandler = () => ({
    results: [{ id: randomUUID(), title: 'Mock Decision', status: 'active' }],
  });

  private credentialHandlers: Record<string, CredentialHandler> = {};

  /** Override the ingest response */
  onIngest(handler: IngestHandler): void {
    this.ingestHandler = handler;
  }

  /** Override the ingestBatch response */
  onIngestBatch(handler: IngestHandler): void {
    this.ingestBatchHandler = handler;
  }

  /** Override credential fetch for a specific platform */
  onFetchCredentials(platform: string, handler: CredentialHandler): void {
    this.credentialHandlers[platform] = handler;
  }

  async ingest(tenantId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.ingest.push({ tenantId, payload });
    return this.ingestHandler(tenantId, payload);
  }

  async ingestBatch(tenantId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.calls.ingestBatch.push({ tenantId, payload });
    return this.ingestBatchHandler(tenantId, payload);
  }

  async fetchJiraCredentials(tenantId: string): Promise<Record<string, string>> {
    return this.fetchCredentials('jira', tenantId);
  }

  async fetchSlackCredentials(tenantId: string): Promise<Record<string, string>> {
    return this.fetchCredentials('slack', tenantId);
  }

  async fetchGitHubCredentials(tenantId: string): Promise<Record<string, string>> {
    return this.fetchCredentials('github', tenantId);
  }

  async fetchConfluenceCredentials(tenantId: string): Promise<Record<string, string>> {
    return this.fetchCredentials('confluence', tenantId);
  }

  async fetchTeamsCredentials(tenantId: string): Promise<Record<string, string>> {
    return this.fetchCredentials('teams', tenantId);
  }

  private async fetchCredentials(platform: string, tenantId: string): Promise<Record<string, string>> {
    this.calls.credentials.push({ tenantId, platform });
    const handler = this.credentialHandlers[platform];
    if (handler) return handler(tenantId);
    return { token: `mock-${platform}-token-${tenantId}` };
  }

  async searchDecisions(
    tenantId: string,
    query: string,
    options?: DecisionSearchOptions,
  ): Promise<DecisionSearchResponse> {
    this.calls.searchDecisions.push({ tenantId, query, options });
    return {
      query,
      results: [
        {
          id: randomUUID(),
          source_url: 'https://example.com',
          platform: 'slack',
          title: 'Mock Decision',
          summary: 'A mock decision for testing',
          created_at: new Date().toISOString(),
          status: 'active',
          similarity: 0.95,
        },
      ],
      count: 1,
      strategy: 'semantic',
    };
  }

  /** Reset all call logs */
  reset(): void {
    this.calls = { ingest: [], ingestBatch: [], credentials: [], searchDecisions: [] };
  }
}
