import { describe, expect, it } from 'vitest';

describe('@aligndottech/connector-server exports', () => {
  it('exports the server plumbing', async () => {
    const server = await import('../index.js');
    expect(typeof server.createConnectorApp).toBe('function');
    expect(typeof server.createMcpHandler).toBe('function');
    expect(server.WebhookGuard).toBeDefined();
    expect(server.BaseCredentialResolver).toBeDefined();
    expect(typeof server.createRequestContext).toBe('function');
  });

  it('exports observability + test harness', async () => {
    const server = await import('../index.js');
    expect(typeof server.setupConnectorOtel).toBe('function');
    expect(typeof server.createStructuredLogger).toBe('function');
    expect(server.TestHarness).toBeDefined();
  });
});
