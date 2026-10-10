/**
 * Like routedFetch, but a response can carry a status: `{ __status: 404, body }`.
 * Routes by substring of `<url>\n<body>`; the most specific key (most ` & ` parts, then
 * longest) wins. An unrouted request throws and is collected, so a test can assert that
 * NO request was made (`calls` empty) or name the stray one.
 */
import type { Mock } from 'vitest';

export interface StatusRoute {
  __status: number;
  body?: unknown;
  /** Response headers, e.g. `{ location: 'https://...' }` for a 3xx. */
  headers?: Record<string, string>;
}

export function serve(mockFetch: Mock, responses: Record<string, unknown>): { calls: Array<{ url: string; body: string }>; unmatched: string[] } {
  const calls: Array<{ url: string; body: string }> = [];
  const unmatched: string[] = [];
  const rules = Object.entries(responses).map(([key, body]) => ({ key, parts: key.split(' & '), body }));
  mockFetch.mockImplementation(async (input: unknown, init?: { body?: unknown }) => {
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url: String(input), body });
    const hay = `${String(input)}\n${body}`;
    const hit = rules
      .filter((r) => r.parts.every((p) => hay.includes(p)))
      .sort((a, b) => b.parts.length - a.parts.length || b.key.length - a.key.length)[0];
    if (!hit) {
      unmatched.push(String(input));
      throw new Error(`no response routed for ${String(input)}`);
    }
    const r = hit.body as Partial<StatusRoute> | undefined;
    const status = r && typeof r === 'object' && '__status' in r ? (r.__status as number) : 200;
    const payload = r && typeof r === 'object' && '__status' in r ? r.body : hit.body;
    const headers = (r && typeof r === 'object' && '__status' in r ? r.headers : undefined) ?? {};
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload ?? '')),
    };
  });
  return { calls, unmatched };
}
