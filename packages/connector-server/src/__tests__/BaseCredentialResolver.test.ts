import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BaseCredentialResolver } from '../auth/BaseCredentialResolver.js';

describe('BaseCredentialResolver', () => {
  beforeEach(() => {
    // The env-var bypass is test-only, so every case states which side it is on. The cases
    // below that prove the bypass is OFF override this.
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('GATEWAY_BEARER_TOKEN', undefined);
    vi.stubEnv('SERVICE_AUTH_TOKEN', undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should resolve from env vars when configured (Tier 1b)', async () => {
    vi.stubEnv('MY_TOKEN', 'test-token');
    const resolver = new BaseCredentialResolver({
      platform: 'test',
      envVars: { token: 'MY_TOKEN' },
      gatewayEndpoint: '/integrations/test/credentials',
    });
    const creds = await resolver.resolve({});
    expect(creds).toEqual({ token: 'test-token' });
  });

  it('should resolve from direct header (Tier 1a)', async () => {
    const resolver = new BaseCredentialResolver({
      platform: 'test',
      directTokenHeader: 'x-test-token',
      gatewayEndpoint: '/integrations/test/credentials',
    });
    const creds = await resolver.resolve({ headers: { 'x-test-token': 'direct-token' } });
    expect(creds).toEqual({ token: 'direct-token' });
  });

  it('should exchange bearer with gateway (Tier 2)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: 'gateway-token' }),
    });
    const resolver = new BaseCredentialResolver({
      platform: 'test',
      gatewayEndpoint: '/integrations/test/credentials',
      fetchFn: mockFetch as any,
    });
    const creds = await resolver.resolve({ bearer: 'user-bearer' });
    expect(creds).toEqual({ token: 'gateway-token' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/integrations/test/credentials'),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer user-bearer' }),
      })
    );
  });

  it('should throw unauthorized when no credentials available', async () => {
    const resolver = new BaseCredentialResolver({
      platform: 'test',
      gatewayEndpoint: '/integrations/test/credentials',
    });
    await expect(resolver.resolve({})).rejects.toThrow('unauthorized');
  });

  it('should throw descriptive error on gateway exchange failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve('Forbidden'),
    });
    const resolver = new BaseCredentialResolver({
      platform: 'test',
      gatewayEndpoint: '/integrations/test/credentials',
      fetchFn: mockFetch as any,
    });
    await expect(resolver.resolve({ bearer: 'bad' })).rejects.toThrow('test_cred_exchange_failed:403');
  });

  it('should support multi-value credentials (e.g., apiKey + appKey)', async () => {
    vi.stubEnv('DD_API_KEY', 'api');
    vi.stubEnv('DD_APP_KEY', 'app');
    const resolver = new BaseCredentialResolver({
      platform: 'datadog',
      envVars: { apiKey: 'DD_API_KEY', appKey: 'DD_APP_KEY' },
      gatewayEndpoint: '/integrations/datadog/credentials',
    });
    const creds = await resolver.resolve({});
    expect(creds).toEqual({ apiKey: 'api', appKey: 'app' });
  });

  it('should support tenantId-based resolution', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: 'tenant-token' }),
    });
    const resolver = new BaseCredentialResolver({
      platform: 'jira',
      gatewayEndpoint: '/integrations/jira/credentials',
      gatewayBearerToken: 'service-key',
      fetchFn: mockFetch as any,
    });
    const creds = await resolver.resolve({ tenantId: 'tenant-123' });
    expect(creds).toEqual({ token: 'tenant-token' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-tenant-id': 'tenant-123', authorization: 'Bearer service-key' }),
      })
    );
  });

  it('should prioritize direct header over env vars', async () => {
    vi.stubEnv('MY_TOKEN', 'env-token');
    const resolver = new BaseCredentialResolver({
      platform: 'test',
      directTokenHeader: 'x-test-token',
      envVars: { token: 'MY_TOKEN' },
      gatewayEndpoint: '/integrations/test/credentials',
    });
    const creds = await resolver.resolve({ headers: { 'x-test-token': 'header-token' } });
    expect(creds).toEqual({ token: 'header-token' });
  });

  it('should validate required fields in gateway response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ token: 'tok' }),
    });
    const resolver = new BaseCredentialResolver({
      platform: 'test',
      gatewayEndpoint: '/integrations/test/credentials',
      requiredFields: ['token', 'base_url'],
      fetchFn: mockFetch as any,
    });
    await expect(resolver.resolve({ bearer: 'tok' })).rejects.toThrow('test_creds_missing:base_url');
  });
  describe('fails closed when the gateway exchange has no credential', () => {
    const exchange = (fetchFn: unknown, extra: object = {}) =>
      new BaseCredentialResolver({
        platform: 'jira',
        gatewayEndpoint: '/integrations/jira/credentials',
        fetchFn: fetchFn as any,
        ...extra,
      });

    it('a tenantId with no caller bearer and no service bearer rejects and sends nothing', async () => {
      const fetchFn = vi.fn();
      await expect(exchange(fetchFn).resolve({ tenantId: 'tenant-123' })).rejects.toMatchObject({
        code: 'gateway_bearer_not_configured',
      });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it('a blank configured service bearer counts as none', async () => {
      const fetchFn = vi.fn();
      await expect(
        exchange(fetchFn, { gatewayBearerToken: '  ' }).resolve({ tenantId: 'tenant-456' }),
      ).rejects.toMatchObject({ code: 'gateway_bearer_not_configured' });
      expect(fetchFn).not.toHaveBeenCalled();
    });

    const okFetch = () => vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ token: 't' }) });
    const authorizationOf = (fetchFn: ReturnType<typeof vi.fn>) => fetchFn.mock.calls[0][1].headers.authorization;

    it('uses GATEWAY_BEARER_TOKEN from the environment when only it is set', async () => {
      vi.stubEnv('GATEWAY_BEARER_TOKEN', 'relay-key');
      const fetchFn = okFetch();
      await exchange(fetchFn).resolve({ tenantId: 'tenant-123' });
      expect(authorizationOf(fetchFn)).toBe('Bearer relay-key');
    });

    it('falls back to SERVICE_AUTH_TOKEN, and prefers GATEWAY_BEARER_TOKEN when both are set', async () => {
      vi.stubEnv('SERVICE_AUTH_TOKEN', 'shared-token');
      const onlyShared = okFetch();
      await exchange(onlyShared).resolve({ tenantId: 'tenant-123' });
      expect(authorizationOf(onlyShared)).toBe('Bearer shared-token');

      vi.stubEnv('GATEWAY_BEARER_TOKEN', 'relay-key');
      const both = okFetch();
      await exchange(both).resolve({ tenantId: 'tenant-123' });
      expect(authorizationOf(both)).toBe('Bearer relay-key');
    });

    it("the caller's own bearer still wins and needs no service bearer", async () => {
      const fetchFn = okFetch();
      await exchange(fetchFn).resolve({ bearer: 'user-bearer', tenantId: 'tenant-123' });
      expect(authorizationOf(fetchFn)).toBe('Bearer user-bearer');
    });
  });

  describe('the envVars bypass is test-only', () => {
    const withEnvVar = () =>
      new BaseCredentialResolver({
        platform: 'test',
        envVars: { token: 'MY_TOKEN' },
        gatewayEndpoint: '/integrations/test/credentials',
      });

    it.each(['production', 'development'])('is ignored when NODE_ENV is %s', async (nodeEnv) => {
      vi.stubEnv('NODE_ENV', nodeEnv);
      vi.stubEnv('MY_TOKEN', 'ambient-token');
      await expect(withEnvVar().resolve({})).rejects.toThrow('unauthorized');
    });

    it('is ignored when NODE_ENV is unset', async () => {
      vi.stubEnv('NODE_ENV', undefined);
      vi.stubEnv('MY_TOKEN', 'ambient-token');
      await expect(withEnvVar().resolve({})).rejects.toThrow('unauthorized');
    });

    it('is honoured when NODE_ENV is test', async () => {
      vi.stubEnv('MY_TOKEN', 'ambient-token');
      expect(await withEnvVar().resolve({})).toEqual({ token: 'ambient-token' });
    });
  });
});
