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

/**
 * ALI-691: `request()` is `protected` so every real caller reaches it only through a public
 * method. None of today's public methods take a `headers` option, so this thin subclass is
 * the only way to drive the new passthrough directly - the alternative is waiting for a
 * connector-side caller to exist first, which is backwards for TDD.
 */
class TestableGatewayClient extends GatewayClient {
  public testRequest<T>(
    path: string,
    options?: { method?: string; body?: unknown; tenantId?: string; headers?: Record<string, string> },
  ): Promise<T> {
    return this.request<T>(path, options);
  }
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

  // ALI-691: a caller (e.g. a connector attesting its platform via x-align-platform) can pass
  // extra headers through `options.headers`. They must be additive only - never able to
  // override the headers this client itself resolves (auth, tenant scoping), or a connector
  // could accidentally (or a hostile payload deliberately) launder a request past those checks.
  describe('options.headers passthrough (ALI-691)', () => {
    const testable = () => new TestableGatewayClient({ gatewayUrl: 'http://gw:8080', bearerToken: 'tok' });

    it('merges a caller-supplied header into the outgoing request', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await testable().testRequest('/alignment/conflicts/e1/feedback', {
        method: 'POST',
        body: { verdict: 'true_positive' },
        tenantId: 't1',
        headers: { 'x-align-platform': 'slack' },
      });

      expect(lastCall().opts.headers).toMatchObject({
        'x-align-platform': 'slack',
        'content-type': 'application/json',
        authorization: 'Bearer tok',
        'x-tenant-id': 't1',
      });
    });

    it('cannot override the resolved authorization header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await testable().testRequest('/x', {
        tenantId: 't1',
        headers: { authorization: 'Bearer attacker-supplied' },
      });

      expect(lastCall().opts.headers.authorization).toBe('Bearer tok');
    });

    it('cannot override the resolved x-tenant-id header', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({}));
      await testable().testRequest('/x', {
        tenantId: 't1',
        headers: { 'x-tenant-id': 'someone-elses-tenant' },
      });

      expect(lastCall().opts.headers['x-tenant-id']).toBe('t1');
    });
  });
});
