/**
 * Shared streaming response consumer for all connectors.
 *
 * Consumes SSE events from GatewayClient.streamConversational(),
 * buffers text chunks, and calls a platform-specific MessageUpdater
 * at a configurable interval to progressively update the user's
 * placeholder message.
 */

import type { ConversationalResponse, StreamEvent } from '../types/index.js';

/**
 * Platform-specific message updater.
 * Each connector provides its own implementation (3-5 lines).
 */
export interface MessageUpdater {
  /** Update the placeholder message with the current accumulated text */
  update(text: string): Promise<void>;
}

export interface StreamConsumerOptions {
  /** Minimum milliseconds between message updates (default: 800ms) */
  intervalMs?: number;
}

/**
 * Consume a streaming AI response and progressively update a message.
 *
 * @returns The final ConversationalResponse when the stream completes
 */
export async function consumeStreamWithProgressiveUpdates(
  stream: AsyncIterable<StreamEvent>,
  updater: MessageUpdater,
  options?: StreamConsumerOptions,
): Promise<ConversationalResponse> {
  const intervalMs = options?.intervalMs ?? 800;

  let accumulated = '';
  let lastUpdateTime = 0;
  let completeResponse: ConversationalResponse | null = null;
  let hadError = false;

  for await (const event of stream) {
    if (event.type === 'token' && event.data.text) {
      accumulated += event.data.text;

      const now = Date.now();
      if (now - lastUpdateTime >= intervalMs) {
        lastUpdateTime = now;
        await updater.update(`${accumulated} ...`).catch(() => {});
      }
    } else if (event.type === 'complete') {
      completeResponse = event.data as unknown as ConversationalResponse;
    } else if (event.type === 'error') {
      // If no tokens accumulated yet, throw so caller can fall back to non-streaming
      if (!accumulated) {
        throw new Error(event.data?.error || 'Stream error');
      }
      hadError = true;
    }
  }

  // Final update with complete text (no trailing ellipsis)
  if (accumulated) {
    const finalText = completeResponse?.response_text || accumulated;
    await updater.update(finalText).catch(() => {});
  }

  if (completeResponse) {
    return completeResponse;
  }

  // Fallback: construct response from accumulated text
  return {
    intent: 'clarify',
    response_text: hadError
      ? (accumulated || 'I encountered an error processing your request.')
      : (accumulated || 'No response received.'),
    follow_up_prompts: [],
    confidence: 0,
  } as ConversationalResponse;
}
