import { describe, expect, it, vi } from 'vitest';
import { FETCH_ONE_MAX_BODY_BYTES, readJsonCapped, vendorMessage } from '../fetchers/util/single.js';

/** A response whose body is a real stream of `chunks`, counting how many were pulled. */
function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  let pulled = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= chunks.length) return controller.close();
      controller.enqueue(chunks[pulled++]);
    },
    cancel,
  });
  const text = vi.fn(async () => {
    throw new Error('text() must not be used when a stream is available');
  });
  return { res: { headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, body, text }, pulled: () => pulled, cancel, text };
}

const enc = new TextEncoder();

describe('readJsonCapped', () => {
  it('refuses on content-length alone, without reading the body', async () => {
    const s = streamed([enc.encode('{}')], { 'content-length': String(FETCH_ONE_MAX_BODY_BYTES + 1) });
    expect(await readJsonCapped(s.res)).toEqual({ ok: false });
    expect(s.res.body.locked).toBe(false); // never read (a stream may prefill one chunk by itself)
  });

  it('counts BYTES, not characters: 1.2M two-byte characters is over the cap though under it in length', async () => {
    const chunk = enc.encode('é'.repeat(100_000)); // 200,000 bytes, 100,000 characters
    const s = streamed(Array.from({ length: 12 }, () => chunk)); // 2.4M bytes, 1.2M characters
    expect(await readJsonCapped(s.res)).toEqual({ ok: false });
  });

  it('aborts at the cap: later chunks are never pulled and the stream is cancelled', async () => {
    const chunk = new Uint8Array(1_000_000).fill(120);
    const s = streamed(Array.from({ length: 50 }, () => chunk));
    expect(await readJsonCapped(s.res)).toEqual({ ok: false });
    expect(s.pulled()).toBeLessThan(10);
    expect(s.cancel).toHaveBeenCalled();
  });

  it('parses a small streamed body, including multi-byte text split across chunks', async () => {
    const bytes = enc.encode(JSON.stringify({ a: 'é€' }));
    const s = streamed([bytes.slice(0, 9), bytes.slice(9)]);
    expect(await readJsonCapped(s.res)).toEqual({ ok: true, value: { a: 'é€' } });
  });

  it('with no stream, falls back to text() and still counts bytes', async () => {
    const text = async () => JSON.stringify({ a: 'é'.repeat(FETCH_ONE_MAX_BODY_BYTES / 2) });
    expect(await readJsonCapped({ text })).toEqual({ ok: false });
    expect(await readJsonCapped({ text: async () => '{"a":1}' })).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe('vendorMessage', () => {
  it('caps the length', () => {
    expect(vendorMessage('y'.repeat(500)).length).toBeLessThanOrEqual(121);
  });
  it.each(['lin_api_ABCDEF1234567890', 'lin_oauth_ABCDEF1234567890', 'Bearer abc.def-ghi', 'ghp_' + 'a'.repeat(36), 'A1b2C3d4E5f6G7h8I9j0K1l2'])(
    'removes the token-like string %s',
    (tok) => {
      expect(vendorMessage(`bad key ${tok} given`)).not.toContain(tok.slice(-8));
    },
  );
  it('keeps an ordinary short message', () => {
    expect(vendorMessage('Entity not found: Issue')).toBe('Entity not found: Issue');
  });
});
