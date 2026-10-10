import { describe, expect, it } from 'vitest';
import { DescendingWindow } from '../fetchers/util/since.js';

// Bounds are parsed by S2's parseWindow (fetchers.window.test.ts); this file covers the stop.
const sinceMs = (iso: string) => Date.parse(iso);

describe('DescendingWindow', () => {
  const D = '2026-05-10T00:00:00Z';
  it('keeps items at or after since and stops at the first one before it', () => {
    const w = new DescendingWindow(sinceMs(D));
    expect(w.place('2026-05-11T00:00:00Z')).toBe('keep');
    expect(w.place(D)).toBe('keep');
    expect(w.place('2026-05-09T00:00:00Z')).toBe('stop');
    expect(w.skips('pages')).toEqual([]);
  });

  it('keeps everything when there is no since', () => {
    const w = new DescendingWindow(undefined);
    expect(w.place('2001-01-01T00:00:00Z')).toBe('keep');
  });

  it('an item newer than the one before it breaks the sort: old items are dropped, never a stop, and it is counted', () => {
    const w = new DescendingWindow(sinceMs(D));
    expect(w.place('2026-05-11T00:00:00Z')).toBe('keep');
    expect(w.place('2026-05-12T00:00:00Z')).toBe('keep'); // out of order
    expect(w.place('2026-05-01T00:00:00Z')).toBe('drop');
    expect(w.place('2026-05-20T00:00:00Z')).toBe('keep'); // out of order again
    const skips = w.skips('pages');
    expect(skips).toHaveLength(1);
    expect(skips[0]).toMatchObject({ kind: 'shape', count: 2 });
    expect(skips[0].detail).toMatch(/pages out of last-modified order/);
  });

  it('an item with no time is kept and counted, because it cannot be placed in the window', () => {
    const w = new DescendingWindow(sinceMs(D));
    expect(w.place(undefined)).toBe('keep');
    expect(w.place('not a date')).toBe('keep');
    expect(w.skips('pages')).toEqual([{ kind: 'shape', count: 2, detail: expect.stringMatching(/pages with no last-modified time/) }]);
  });
});
