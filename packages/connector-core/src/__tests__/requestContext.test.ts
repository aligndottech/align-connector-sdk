import { describe, expect, it } from 'vitest';
import {
  getContext,
  tryGetContext,
  runWithContext,
  runWithContextAsync,
  extractBearer,
  getBearer,
} from '../utils/requestContext.js';

describe('requestContext', () => {
  it('getContext throws outside a request scope', () => {
    expect(() => getContext()).toThrowError('missing_request_context');
  });

  it('tryGetContext returns undefined outside a request scope', () => {
    expect(tryGetContext()).toBeUndefined();
  });

  it('runWithContext makes the context available to getContext', () => {
    const result = runWithContext({ tenantId: 't1', bearerToken: 'abc' }, () => {
      return getContext();
    });
    expect(result).toMatchObject({ tenantId: 't1', bearerToken: 'abc' });
  });

  it('runWithContextAsync propagates context across awaits', async () => {
    const tenant = await runWithContextAsync({ tenantId: 't2' }, async () => {
      await Promise.resolve();
      return getContext().tenantId;
    });
    expect(tenant).toBe('t2');
  });

  it('extractBearer strips the Bearer prefix and rejects others', () => {
    expect(extractBearer('Bearer xyz123')).toBe('xyz123');
    expect(extractBearer('Basic xyz')).toBeUndefined();
    expect(extractBearer(undefined)).toBeUndefined();
    expect(getBearer('Bearer t')).toBe('t');
  });
});
