import { describe, expect, it } from 'vitest';
import {
  verifyWebhookSecret,
  isWebhookSecretConfigured,
  realtimeHealth,
} from '../webhooks/verifyWebhookSecret.js';

describe('verifyWebhookSecret', () => {
  it('rejects with missing_secret when no secret is configured', () => {
    expect(verifyWebhookSecret('anything', undefined)).toEqual({
      ok: false,
      reason: 'missing_secret',
    });
  });

  it('rejects with missing_secret when the configured secret is blank/whitespace', () => {
    expect(verifyWebhookSecret('anything', '   ')).toEqual({
      ok: false,
      reason: 'missing_secret',
    });
  });

  it('accepts when the provided secret matches the configured secret', () => {
    expect(verifyWebhookSecret('shared-secret', 'shared-secret')).toEqual({ ok: true });
  });

  it('rejects with bad_secret when the provided secret does not match', () => {
    expect(verifyWebhookSecret('wrong', 'shared-secret')).toEqual({
      ok: false,
      reason: 'bad_secret',
    });
  });

  it('rejects with bad_secret when no secret was provided at all', () => {
    expect(verifyWebhookSecret(undefined, 'shared-secret')).toEqual({
      ok: false,
      reason: 'bad_secret',
    });
  });

  it('rejects with bad_secret when the provided secret has a different length', () => {
    // Exercises the length-mismatch branch of the constant-time comparison directly,
    // rather than relying on timing to prove it never reaches timingSafeEqual with
    // mismatched buffer lengths (which throws).
    expect(verifyWebhookSecret('short', 'a-much-longer-configured-secret')).toEqual({
      ok: false,
      reason: 'bad_secret',
    });
  });
});

describe('isWebhookSecretConfigured', () => {
  it('is false when undefined', () => {
    expect(isWebhookSecretConfigured(undefined)).toBe(false);
  });

  it('is false when blank/whitespace', () => {
    expect(isWebhookSecretConfigured('   ')).toBe(false);
  });

  it('is true when a real value is set', () => {
    expect(isWebhookSecretConfigured('a-secret')).toBe(true);
  });
});

describe('realtimeHealth', () => {
  it('reports live when a secret is configured', () => {
    expect(realtimeHealth('a-secret')).toEqual({ ok: true, realtime: 'live' });
  });

  it('reports dark with missing_secret when unconfigured', () => {
    expect(realtimeHealth(undefined)).toEqual({
      ok: true,
      realtime: 'dark',
      reason: 'missing_secret',
    });
  });
});
