/**
 * Serve canned responses from a mocked undici `fetch`, routed by request content.
 *
 * A key is one or more ` & `-separated substrings that must ALL appear in the
 * request (the URL, a newline, then the body). The most specific key wins: most
 * parts first, then the longest key, so `conversations.list & cursor=P2` beats
 * `conversations.list` for the second page and `/teams/T1/channels/CH1/messages`
 * beats `/teams/T1/channels`. Order in the map never matters.
 *
 * A request nothing anticipated throws AND is collected, so a test can name it.
 * Throwing alone is not enough: several fetchers swallow a failed lookup (a Slack
 * `users.info`, a Notion block read) and would quietly produce a smaller item.
 *
 * A string body is served through `text()`; anything else through `json()`.
 */
import type { Mock } from 'vitest';

export interface RoutedCall {
  url: string;
  body: string;
}

export function routeResponses(
  mockFetch: Mock,
  responses: Record<string, unknown>,
): { calls: RoutedCall[]; unmatched: string[] } {
  const calls: RoutedCall[] = [];
  const unmatched: string[] = [];
  const rules = Object.entries(responses).map(([key, body]) => ({ key, parts: key.split(' & '), body }));
  mockFetch.mockImplementation(async (input: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url: String(input), body });
    const haystack = `${String(input)}\n${body}`;
    const hit = rules
      .filter((r) => r.parts.every((p) => haystack.includes(p)))
      .sort((a, b) => b.parts.length - a.parts.length || b.key.length - a.key.length)[0];
    if (!hit) {
      unmatched.push(String(input));
      throw new Error(`no response routed for ${String(input)}`);
    }
    const b = hit.body;
    return {
      ok: true,
      status: 200,
      json: async () => b,
      text: async () => (typeof b === 'string' ? b : JSON.stringify(b)),
    };
  });
  return { calls, unmatched };
}
