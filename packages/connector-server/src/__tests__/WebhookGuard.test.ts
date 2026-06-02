import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { WebhookGuard } from '../webhooks/WebhookGuard.js';

describe('WebhookGuard', () => {
  describe('HMAC verification', () => {
    it('should verify valid HMAC-SHA256 signature', () => {
      const guard = new WebhookGuard({ secret: 'test-secret' });
      const payload = '{"event":"test"}';
      const sig = createHmac('sha256', 'test-secret').update(payload).digest('hex');
      expect(guard.verifySignature(payload, sig)).toBe(true);
      guard.destroy();
    });

    it('should reject invalid signature', () => {
      const guard = new WebhookGuard({ secret: 'test-secret' });
      expect(guard.verifySignature('payload', 'invalid-sig')).toBe(false);
      guard.destroy();
    });

    it('should handle different length signatures safely', () => {
      const guard = new WebhookGuard({ secret: 'test-secret' });
      expect(guard.verifySignature('test', 'short')).toBe(false);
      guard.destroy();
    });

    it('should skip verification when no secret configured', () => {
      const guard = new WebhookGuard({});
      expect(guard.verifySignature('payload', 'any')).toBe(true);
      guard.destroy();
    });

    it('should support custom algorithm', () => {
      const guard = new WebhookGuard({ secret: 'test-secret', algorithm: 'sha1' });
      const payload = 'test';
      const sig = createHmac('sha1', 'test-secret').update(payload).digest('hex');
      expect(guard.verifySignature(payload, sig)).toBe(true);
      guard.destroy();
    });
  });

  describe('deduplication', () => {
    it('should reject duplicate event IDs', () => {
      const guard = new WebhookGuard({});
      expect(guard.isDuplicate('evt-1')).toBe(false);
      expect(guard.isDuplicate('evt-1')).toBe(true);
      guard.destroy();
    });

    it('should allow different event IDs', () => {
      const guard = new WebhookGuard({});
      expect(guard.isDuplicate('evt-1')).toBe(false);
      expect(guard.isDuplicate('evt-2')).toBe(false);
      guard.destroy();
    });

    it('should clear duplicates after configured interval', () => {
      vi.useFakeTimers();
      const guard = new WebhookGuard({ dedupTtlMs: 1000 });
      guard.isDuplicate('evt-1');
      expect(guard.isDuplicate('evt-1')).toBe(true);
      vi.advanceTimersByTime(1001);
      expect(guard.isDuplicate('evt-1')).toBe(false);
      guard.destroy();
      vi.useRealTimers();
    });

    it('should respect max set size to prevent memory leaks', () => {
      const guard = new WebhookGuard({ dedupMaxSize: 2 });
      guard.isDuplicate('a');
      guard.isDuplicate('b');
      guard.isDuplicate('c'); // triggers clear since size >= 2
      expect(guard.getDedupSize()).toBeLessThanOrEqual(2);
      guard.destroy();
    });
  });

  describe('cleanup', () => {
    it('should stop dedup timer on destroy', () => {
      const guard = new WebhookGuard({ dedupTtlMs: 60000 });
      guard.isDuplicate('evt-1');
      guard.destroy();
      expect(guard.getDedupSize()).toBe(0);
    });
  });
});
