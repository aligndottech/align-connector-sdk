import { randomUUID } from 'node:crypto';

/** Common test fixtures for connector development */
export const fixtures = {
  /** A sample decision snapshot */
  decision(overrides?: Record<string, unknown>) {
    return {
      id: randomUUID(),
      title: 'Use Express for all connectors',
      description: 'Standardize on Express framework for consistency and shared middleware.',
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      ...overrides,
    };
  },

  /** A sample ingest response from the gateway */
  ingestResponse(overrides?: Record<string, unknown>) {
    return {
      id: randomUUID(),
      title: 'Sample Decision',
      status: 'active',
      confidence: 0.85,
      ...overrides,
    };
  },

  /** A sample batch ingest response */
  ingestBatchResponse(count = 2) {
    return {
      results: Array.from({ length: count }, () => fixtures.ingestResponse()),
    };
  },

  /** A sample webhook payload (generic) */
  webhookPayload(overrides?: Record<string, unknown>) {
    return {
      event_id: randomUUID(),
      event_type: 'message.created',
      timestamp: new Date().toISOString(),
      data: { content: 'We decided to use TypeScript for all services.' },
      ...overrides,
    };
  },

  /** A sample tenant context */
  tenantContext(overrides?: Record<string, unknown>) {
    return {
      tenantId: randomUUID(),
      bearer: `test-bearer-${randomUUID().slice(0, 8)}`,
      ...overrides,
    };
  },

  /** Sample OAuth credentials */
  oauthCredentials(platform: string) {
    return {
      token: `mock-${platform}-token`,
      refresh_token: `mock-${platform}-refresh`,
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    };
  },
};
