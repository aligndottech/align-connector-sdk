import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseCredentialResolver } from '../auth/BaseCredentialResolver.js';

describe('BaseCredentialResolver', () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should resolve from env vars when configured (Tier 1b)', async () => {
    process.env.MY_TOKEN = 'test-token';
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
    process.env.DD_API_KEY = 'api';
    process.env.DD_APP_KEY = 'app';
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
      fetchFn: mockFetch as any,
    });
    const creds = await resolver.resolve({ tenantId: 'tenant-123' });
    expect(creds).toEqual({ token: 'tenant-token' });
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'x-tenant-id': 'tenant-123' }),
      })
    );
  });

  it('should prioritize direct header over env vars', async () => {
    process.env.MY_TOKEN = 'env-token';
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
});
