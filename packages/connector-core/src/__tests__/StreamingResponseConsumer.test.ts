import { describe, expect, it, vi } from 'vitest';
import { consumeStreamWithProgressiveUpdates } from '../services/StreamingResponseConsumer.js';
import type { StreamEvent } from '../types/index.js';

describe('consumeStreamWithProgressiveUpdates', () => {
  it('should call updater.update with accumulated text at intervals', async () => {
    const mockUpdate = vi.fn().mockResolvedValue(undefined);

    async function* mockStream(): AsyncGenerator<StreamEvent> {
      yield { type: 'token', data: { text: 'Hello' } };
      yield { type: 'token', data: { text: ' world' } };
      yield { type: 'token', data: { text: '!' } };
      yield {
        type: 'complete',
        data: {
          intent: 'question',
          response_text: 'Hello world!',
          follow_up_prompts: [],
          confidence: 0.8,
        },
      };
    }

    const result = await consumeStreamWithProgressiveUpdates(
      mockStream(),
      { update: mockUpdate },
      { intervalMs: 0 }, // Immediate updates for testing
    );

    expect(mockUpdate).toHaveBeenCalled();
    // Last update should include full text
    const lastCallText = mockUpdate.mock.calls[mockUpdate.mock.calls.length - 1][0];
    expect(lastCallText).toContain('Hello world!');

    expect(result.intent).toBe('question');
    expect(result.response_text).toBe('Hello world!');
  });

  it('should not fail if updater.update throws', async () => {
    const mockUpdate = vi.fn().mockRejectedValue(new Error('API down'));

    async function* mockStream(): AsyncGenerator<StreamEvent> {
      yield { type: 'token', data: { text: 'Hi' } };
      yield { type: 'complete', data: { intent: 'help', response_text: 'Hi', follow_up_prompts: [], confidence: 1 } };
    }

    // Should not throw despite update failures
    const result = await consumeStreamWithProgressiveUpdates(
      mockStream(),
      { update: mockUpdate },
      { intervalMs: 0 },
    );

    expect(result.response_text).toBe('Hi');
  });

  it('should handle error events gracefully', async () => {
    const mockUpdate = vi.fn().mockResolvedValue(undefined);

    async function* mockStream(): AsyncGenerator<StreamEvent> {
      yield { type: 'token', data: { text: 'Partial' } };
      yield { type: 'error', data: { error: 'LLM failed' } };
    }

    const result = await consumeStreamWithProgressiveUpdates(
      mockStream(),
      { update: mockUpdate },
      { intervalMs: 0 },
    );

    // Should return what we got with error indication
    expect(result.response_text).toContain('Partial');
    expect(result.intent).toBe('clarify');
  });

  it('should throw on error when no tokens accumulated (enables fallback)', async () => {
    const mockUpdate = vi.fn().mockResolvedValue(undefined);

    async function* mockStream(): AsyncGenerator<StreamEvent> {
      yield { type: 'error', data: { error: 'Gateway error 500: stream_failed' } };
    }

    await expect(
      consumeStreamWithProgressiveUpdates(
        mockStream(),
        { update: mockUpdate },
        { intervalMs: 0 },
      ),
    ).rejects.toThrow('Gateway error 500: stream_failed');
  });

  it('should respect update interval to avoid rate limiting', async () => {
    const mockUpdate = vi.fn().mockResolvedValue(undefined);
    const tokens = Array.from({ length: 20 }, (_, i) => `word${i}`);

    async function* mockStream(): AsyncGenerator<StreamEvent> {
      for (const token of tokens) {
        yield { type: 'token', data: { text: ` ${token}` } };
      }
      yield { type: 'complete', data: { intent: 'question', response_text: tokens.join(' '), follow_up_prompts: [], confidence: 0.8 } };
    }

    await consumeStreamWithProgressiveUpdates(
      mockStream(),
      { update: mockUpdate },
      { intervalMs: 100_000 }, // Very high interval - should only update once at start
    );

    // With a huge interval, should call update very few times (just the first token trigger)
    expect(mockUpdate.mock.calls.length).toBeLessThan(5);
  });
});
