import { afterEach, describe, expect, it, vi } from 'vitest';
import { GatewayClient } from '../services/GatewayClient.js';

// Mock undici fetch at module level
vi.mock('undici', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    fetch: vi.fn(),
  };
});

import { fetch } from 'undici';

afterEach(() => vi.clearAllMocks());

describe('GatewayClient.streamConversational', () => {
  it('should yield token and complete events from SSE stream', async () => {
    const client = new GatewayClient({ gatewayUrl: 'http://localhost:8080' });

    const sseBody = [
      'event: token\ndata: {"text": "Hello"}\n\n',
      'event: token\ndata: {"text": " world"}\n\n',
      'event: complete\ndata: {"intent":"question","response_text":"Hello world","follow_up_prompts":[],"confidence":0.8}\n\n',
    ].join('');

    const chunks = [new TextEncoder().encode(sseBody)];
    let index = 0;

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: () => {
            if (index < chunks.length) {
              return Promise.resolve({ done: false, value: chunks[index++] });
            }
            return Promise.resolve({ done: true, value: undefined });
          },
          releaseLock: () => {},
        }),
      },
    } as any);

    const events: Array<{ type: string; data: any }> = [];
    for await (const event of client.streamConversational('tenant-1', {
      message: 'test',
      conversation_history: [],
      platform: 'slack',
      context: {},
    })) {
      events.push(event);
    }

    const tokens = events.filter((e) => e.type === 'token');
    const completes = events.filter((e) => e.type === 'complete');

    expect(tokens).toHaveLength(2);
    expect(tokens[0].data.text).toBe('Hello');
    expect(tokens[1].data.text).toBe(' world');
    expect(completes).toHaveLength(1);
    expect(completes[0].data.intent).toBe('question');
  });

  it('should yield error event on HTTP failure', async () => {
    const client = new GatewayClient({ gatewayUrl: 'http://localhost:8080' });

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Internal error',
    } as any);

    const events: Array<{ type: string; data: any }> = [];
    for await (const event of client.streamConversational('tenant-1', {
      message: 'test',
      conversation_history: [],
      platform: 'slack',
      context: {},
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('error');
  });
});
