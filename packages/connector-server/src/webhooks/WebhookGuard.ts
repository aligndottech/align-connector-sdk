import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WebhookGuardConfig {
  /** HMAC secret for signature verification. If omitted, verification is skipped. */
  secret?: string;
  /** HMAC algorithm. Default: 'sha256' */
  algorithm?: string;
  /** How long to keep event IDs for deduplication. Default: 3600000 (1 hour) */
  dedupTtlMs?: number;
  /** Max dedup set size before forced clear (prevents memory leaks). Default: 10000 */
  dedupMaxSize?: number;
}

export class WebhookGuard {
  private secret?: string;
  private algorithm: string;
  private processedIds = new Set<string>();
  private dedupTimer?: ReturnType<typeof setInterval>;
  private dedupMaxSize: number;

  constructor(config: WebhookGuardConfig) {
    this.secret = config.secret;
    this.algorithm = config.algorithm ?? 'sha256';
    this.dedupMaxSize = config.dedupMaxSize ?? 10000;

    const ttl = config.dedupTtlMs ?? 3600000;
    if (ttl > 0) {
      this.dedupTimer = setInterval(() => this.processedIds.clear(), ttl);
      if (this.dedupTimer.unref) this.dedupTimer.unref();
    }
  }

  /**
   * Verify HMAC signature. Returns true if no secret is configured (skip mode).
   *
   * Accepts signatures in these formats:
   * - Raw hex: `"abcdef1234..."`
   * - Prefixed: `"sha256=abcdef1234..."` or `"v0=abcdef1234..."`
   *
   * The prefix (everything before `=`) is stripped before comparison.
   * The expected digest is always lowercase hex.
   */
  verifySignature(payload: string, signature: string): boolean {
    if (!this.secret) return true;
    try {
      const expected = createHmac(this.algorithm, this.secret).update(payload).digest('hex');
      // Strip optional algorithm/version prefix (e.g., "sha256=", "v0=")
      const rawSig = signature.includes('=') ? signature.slice(signature.indexOf('=') + 1) : signature;
      const normalizedSig = rawSig.trim().toLowerCase();
      const sigBuf = Buffer.from(normalizedSig, 'utf-8');
      const expBuf = Buffer.from(expected, 'utf-8');
      if (sigBuf.length !== expBuf.length) return false;
      return timingSafeEqual(sigBuf, expBuf);
    } catch {
      return false;
    }
  }

  /** Check if event was already processed. Returns true if duplicate. */
  isDuplicate(eventId: string): boolean {
    if (this.processedIds.has(eventId)) return true;
    if (this.processedIds.size >= this.dedupMaxSize) this.processedIds.clear();
    this.processedIds.add(eventId);
    return false;
  }

  getDedupSize(): number {
    return this.processedIds.size;
  }

  destroy(): void {
    if (this.dedupTimer) clearInterval(this.dedupTimer);
    this.processedIds.clear();
  }
}
