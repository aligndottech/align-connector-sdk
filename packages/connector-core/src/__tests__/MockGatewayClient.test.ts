import { describe, expect, it } from 'vitest';
import { MockGatewayClient } from '../testing/MockGatewayClient.js';

describe('MockGatewayClient', () => {
  it('should return default mock ingest response', async () => {
    const mock = new MockGatewayClient();
    const result = await mock.ingest('tenant-1', { raw_text: 'test', platform: 'slack' });
    expect(result.id).toBeDefined();
    expect(result.title).toBeDefined();
  });

  it('should allow configuring mock responses', async () => {
    const mock = new MockGatewayClient();
    mock.onIngest(() => ({ id: 'custom-id', title: 'Custom Decision' }));
    const result = await mock.ingest('tenant-1', { raw_text: 'test', platform: 'slack' });
    expect(result.id).toBe('custom-id');
  });

  it('should track all calls for assertions', async () => {
    const mock = new MockGatewayClient();
    await mock.ingest('tenant-1', { raw_text: 'test', platform: 'slack' });
    await mock.ingest('tenant-2', { raw_text: 'test2', platform: 'jira' });
    expect(mock.calls.ingest).toHaveLength(2);
    expect(mock.calls.ingest[0].tenantId).toBe('tenant-1');
  });

  it('should support simulating errors', async () => {
    const mock = new MockGatewayClient();
    mock.onIngest(() => {
      throw new Error('gateway_error');
    });
    await expect(mock.ingest('t', {} as any)).rejects.toThrow('gateway_error');
  });

  it('should provide credential exchange methods', async () => {
    const mock = new MockGatewayClient();
    mock.onFetchCredentials('jira', () => ({ base: 'https://test.atlassian.net', token: 'tok' }));
    const creds = await mock.fetchJiraCredentials('tenant-1');
    expect(creds.base).toBe('https://test.atlassian.net');
  });

  it('should return default credentials when no handler configured', async () => {
    const mock = new MockGatewayClient();
    const creds = await mock.fetchGitHubCredentials('tenant-1');
    expect(creds.token).toContain('mock-github-token');
  });

  it('should track credential calls', async () => {
    const mock = new MockGatewayClient();
    await mock.fetchSlackCredentials('t-1');
    await mock.fetchTeamsCredentials('t-2');
    expect(mock.calls.credentials).toHaveLength(2);
    expect(mock.calls.credentials[0].platform).toBe('slack');
  });

  it('should reset all call logs', async () => {
    const mock = new MockGatewayClient();
    await mock.ingest('t', { raw_text: 'test' });
    await mock.fetchJiraCredentials('t');
    mock.reset();
    expect(mock.calls.ingest).toHaveLength(0);
    expect(mock.calls.credentials).toHaveLength(0);
  });

  it('should support batch ingest', async () => {
    const mock = new MockGatewayClient();
    const result = await mock.ingestBatch('t', { items: [] });
    expect(result.results).toBeDefined();
  });
});
