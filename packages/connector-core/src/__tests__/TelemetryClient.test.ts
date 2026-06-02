import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { TelemetryClient, createTelemetryClient } from '../services/TelemetryClient.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

const okResponse = { ok: true, status: 200 } as unknown as Awaited<ReturnType<typeof fetch>>;

// flushIntervalMs: 0 disables the background timer so tests are deterministic.
function makeClient(overrides = {}) {
  return new TelemetryClient({ gatewayUrl: 'http://gw:8080/', flushIntervalMs: 0, batchSize: 2, ...overrides });
}

function bodyOfCall(i = -1) {
  const [, opts] = mockFetch.mock.calls.at(i) as [string, { headers: Record<string, string>; body: string }];
  return { headers: opts.headers, body: JSON.parse(opts.body) };
}

describe('TelemetryClient', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockResolvedValue(okResponse);
  });

  it('does nothing when disabled', async () => {
    await makeClient({ enabled: false }).track({ eventName: 'x', category: 'system' }, 't1');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('warns and drops events with no tenant id', async () => {
    const logger = vi.fn();
    await makeClient({ logger }).track({ eventName: 'x', category: 'system' });
    expect(mockFetch).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith('warn', expect.stringContaining('without tenant'), expect.anything());
  });

  it('buffers until batchSize then auto-flushes to /telemetry/ingest', async () => {
    const client = makeClient({ batchSize: 2 });
    await client.track({ eventName: 'a', category: 'system' }, 't1');
    expect(mockFetch).not.toHaveBeenCalled(); // 1 < batchSize
    await client.track({ eventName: 'b', category: 'system' }, 't1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe('http://gw:8080/telemetry/ingest'); // trailing slash stripped
    const { headers, body } = bodyOfCall();
    expect(headers['X-Tenant-Id']).toBe('t1');
    expect(body.events.map((e: { eventName: string }) => e.eventName)).toEqual(['a', 'b']);
  });

  it('uses setTenantId when no explicit tenant is passed', async () => {
    const client = makeClient({ batchSize: 1 });
    client.setTenantId('ctx-tenant');
    await client.track({ eventName: 'a', category: 'system' });
    expect(bodyOfCall().headers['X-Tenant-Id']).toBe('ctx-tenant');
  });

  it('applies default platform + connectorKey', async () => {
    const client = makeClient({ batchSize: 1, defaultPlatform: 'slack', defaultConnectorKey: 'mcp-slack' });
    await client.track({ eventName: 'a', category: 'system' }, 't1');
    expect(bodyOfCall().body.events[0]).toMatchObject({ platform: 'slack', connectorKey: 'mcp-slack' });
  });

  it('trackImmediate sends without buffering', async () => {
    await makeClient({ batchSize: 99 }).trackImmediate({ eventName: 'now', category: 'system' }, 't1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('flush groups events by tenant into separate requests', async () => {
    const client = makeClient({ batchSize: 99 });
    await client.track({ eventName: 'a', category: 'system' }, 't1');
    await client.track({ eventName: 'b', category: 'system' }, 't2');
    await client.flush();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const tenants = mockFetch.mock.calls.map((_, i) => bodyOfCall(i).headers['X-Tenant-Id']);
    expect(new Set(tenants)).toEqual(new Set(['t1', 't2']));
  });

  it('flush is a no-op on an empty buffer', async () => {
    await makeClient().flush();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('convenience helpers set the right event name/category', async () => {
    const client = makeClient({ batchSize: 1 });
    await client.trackWebhook('wh1', 'message', true, 12, 't1');
    expect(bodyOfCall().body.events[0]).toMatchObject({ eventName: 'webhook.processed', category: 'connector' });
    await client.trackCommand('capture', false, 5, 't1');
    expect(bodyOfCall().body.events[0]).toMatchObject({ eventName: 'command.failed', category: 'engagement' });
    await client.trackDecisionCaptured('d1', 'manual', 't1');
    expect(bodyOfCall().body.events[0]).toMatchObject({ eventName: 'decision.captured' });
    await client.trackConflictDetected('d1', 'd2', 'high', 't1');
    expect(bodyOfCall().body.events[0]).toMatchObject({ eventName: 'conflict.detected', category: 'value' });
    await client.trackJiraComment('PROJ-1', 'c1', true, 7, 't1');
    expect(bodyOfCall().body.events[0]).toMatchObject({ eventName: 'jira.comment', platform: 'jira' });
    await client.trackJiraIssueLinked('d1', 'PROJ-1', 'relates', 't1');
    expect(bodyOfCall().body.events[0]).toMatchObject({ eventName: 'jira.issue_linked' });
  });

  it('swallows network errors and logs them', async () => {
    const logger = vi.fn();
    mockFetch.mockRejectedValueOnce(new Error('network down'));
    await expect(
      makeClient({ batchSize: 1, logger }).track({ eventName: 'a', category: 'system' }, 't1'),
    ).resolves.toBeUndefined();
    expect(logger).toHaveBeenCalledWith('error', expect.stringContaining('Error sending'), expect.anything());
  });

  it('logs a warning on a non-ok response', async () => {
    const logger = vi.fn();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 } as never);
    await makeClient({ batchSize: 1, logger }).track({ eventName: 'a', category: 'system' }, 't1');
    expect(logger).toHaveBeenCalledWith('warn', expect.stringContaining('Failed to send'), expect.anything());
  });

  it('shutdown flushes remaining events', async () => {
    const client = makeClient({ batchSize: 99 });
    await client.track({ eventName: 'a', category: 'system' }, 't1');
    await client.shutdown();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('createTelemetryClient wires platform as default platform + connector key', async () => {
    const client = createTelemetryClient('http://gw:8080', 'github', { batchSize: 1, flushIntervalMs: 0 });
    await client.track({ eventName: 'a', category: 'system' }, 't1');
    expect(bodyOfCall().body.events[0]).toMatchObject({ platform: 'github', connectorKey: 'github' });
  });
});
