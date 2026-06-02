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

  it('exports observability', async () => {
    const server = await import('../index.js');
    expect(typeof server.setupConnectorOtel).toBe('function');
    expect(typeof server.createStructuredLogger).toBe('function');
  });

  it('does NOT re-export TestHarness from the main barrel', async () => {
    // TestHarness imports supertest (a devDependency). Re-exporting it here would
    // drag supertest into every consumer's production import graph and crash
    // connectors that don't ship it. It lives on the ./testing subpath instead.
    const server = (await import('../index.js')) as Record<string, unknown>;
    expect(server.TestHarness).toBeUndefined();
  });

  it('exposes TestHarness via the ./testing subpath', async () => {
    const testing = await import('../testing/index.js');
    expect(typeof testing.TestHarness).toBe('function');
  });
});
