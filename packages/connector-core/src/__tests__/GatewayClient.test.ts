import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetch } from 'undici';
import { GatewayClient } from '../services/GatewayClient.js';

vi.mock('undici', () => ({ fetch: vi.fn() }));
const mockFetch = vi.mocked(fetch);

function jsonResponse(body: unknown, init?: { status?: number; contentType?: string | null }) {
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    headers: { get: () => (init?.contentType === undefined ? 'application/json' : init.contentType) },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Awaited<ReturnType<typeof fetch>>;
}

function lastCall() {
  const [url, opts] = mockFetch.mock.calls.at(-1) as [string, { method?: string; headers: Record<string, string>; body?: string }];
  return { url, opts };
}

describe('GatewayClient', () => {
  beforeEach(() => mockFetch.mockReset());
  afterEach(() => vi.unstubAllEnvs());

  const client = () => new GatewayClient({ gatewayUrl: 'http://gw:8080', bearerToken: 'tok' });

  it('ingest POSTs /ingest with auth + tenant + json headers and body', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ decision_id: 'd1' }));
    const res = await client().ingest('tenant-1', { text: 'we will use postgres' } as never);

    expect(res).toEqual({ decision_id: 'd1' });
    const { url, opts } = lastCall();
    expect(url).toBe('http://gw:8080/ingest');
    expect(opts.method).toBe('POST');
    expect(opts.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer tok',
      'x-tenant-id': 'tenant-1',
    });
    expect(JSON.parse(opts.body as string)).toEqual({ text: 'we will use postgres' });
  });

  it('consensus and conversational hit their endpoints', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}));
    await client().consensus('t', {} as never);
    expect(lastCall().url).toBe('http://gw:8080/ingest/consensus');
    await client().conversational('t', {} as never);
    expect(lastCall().url).toBe('http://gw:8080/ingest/conversational');
  });

  it('getDecision GETs the snapshot path', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ id: 'd1' }));
    await client().getDecision('t', 'd1');
    const { url, opts } = lastCall();
    expect(url).toBe('http://gw:8080/snapshots/d1');
    expect(opts.method ?? 'GET').toBe('GET');
  });

  it('searchDecisions applies defaults', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({ results: [] }));
    await client().searchDecisions('t', 'postgres');
    expect(JSON.parse(lastCall().opts.body as string)).toEqual({
      query: 'postgres',
      limit: 5,
      exclude_superseded: true,
    });
  });

  it('getDecisions short-circuits on empty input (no fetch)', async () => {
    const out = await client().getDecisions('t', []);
    expect(out).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('throws a descriptive error on non-ok responses', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse('boom', { status: 500 }));
    await expect(client().getDecision('t', 'd1')).rejects.toThrow(/gateway_request_failed .* 500/);
  });

  it('returns undefined for 204 / non-json responses', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(null, { status: 204, contentType: null }));
    const res = await client().getDecision('t', 'd1');
    expect(res).toBeUndefined();
  });

  it('omits auth header when no bearer token is set', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await new GatewayClient({ gatewayUrl: 'http://gw:8080' }).ingest('t', {} as never);
    expect(lastCall().opts.headers.authorization).toBeUndefined();
  });

  it('fromEnv reads GATEWAY_URL / GATEWAY_BEARER_TOKEN with a default', async () => {
    vi.stubEnv('GATEWAY_URL', 'http://env-gw:9000');
    vi.stubEnv('GATEWAY_BEARER_TOKEN', 'env-tok');
    mockFetch.mockResolvedValueOnce(jsonResponse({}));
    await GatewayClient.fromEnv().ingest('t', {} as never);
    const { url, opts } = lastCall();
    expect(url).toBe('http://env-gw:9000/ingest');
    expect(opts.headers.authorization).toBe('Bearer env-tok');
  });
});
