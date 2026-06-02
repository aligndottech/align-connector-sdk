import { describe, expect, it } from 'vitest';
import { TestHarness } from '../testing/TestHarness.js';

describe('TestHarness', () => {
  it('should start a connector with mock gateway', async () => {
    const harness = new TestHarness({
      name: 'test-connector',
      version: '1.0.0',
      setup: () => {
        // No-op setup for basic test
      },
    });
    await harness.start();
    const health = await harness.get('/health');
    expect(health.body.ok).toBe(true);
    expect(health.body.service).toBe('test-connector');
    await harness.stop();
  });

  it('should support sending webhook events', async () => {
    const received: unknown[] = [];
    const harness = new TestHarness({
      name: 'test',
      version: '1.0.0',
      setup: (app) => {
        app.post('/webhook/test', (req, res) => {
          received.push(req.body);
          res.status(200).json({ ok: true });
        });
      },
    });
    await harness.start();
    await harness.postWebhook('/webhook/test', { event: 'test' });
    expect(received).toHaveLength(1);
    await harness.stop();
  });

  it('should provide access to mock gateway', async () => {
    const harness = new TestHarness({
      name: 'test',
      version: '1.0.0',
      setup: (_app, _mcp, gateway) => {
        gateway.onIngest(() => ({ id: 'test-id', title: 'Test' }));
      },
    });
    await harness.start();
    const result = await harness.gateway.ingest('t', { raw_text: 'test' });
    expect(result.id).toBe('test-id');
    await harness.stop();
  });

  it('should throw if used before start', () => {
    const harness = new TestHarness({
      name: 'test',
      version: '1.0.0',
      setup: () => {},
    });
    expect(() => harness.get('/health')).toThrow('TestHarness not started');
  });
});
