import { describe, expect, it } from 'vitest';
import { SlidingWindowLimiter, fakeClockForTests } from '../fetchers/util/pace.js';

describe('SlidingWindowLimiter (vendor request pacing)', () => {
  it('lets up to max requests through a window without waiting', async () => {
    const clock = fakeClockForTests();
    const limiter = new SlidingWindowLimiter(30, 60_000, clock);
    for (let i = 0; i < 30; i++) expect(await limiter.acquire()).toBe(true);
    expect(clock.slept).toEqual([]);
  });

  it('waits until the oldest request leaves the window for request max+1', async () => {
    const clock = fakeClockForTests();
    const limiter = new SlidingWindowLimiter(30, 60_000, clock);
    for (let i = 0; i < 30; i++) await limiter.acquire();
    clock.advance(10_000);
    expect(await limiter.acquire()).toBe(true);
    expect(clock.slept).toEqual([50_000]);
  });

  it('refuses rather than sleeps past a deadline', async () => {
    const clock = fakeClockForTests();
    const limiter = new SlidingWindowLimiter(2, 60_000, clock);
    await limiter.acquire();
    await limiter.acquire();
    expect(await limiter.acquire(clock.now() + 1_000)).toBe(false);
    expect(clock.slept).toEqual([]);
    // A deadline far enough out still waits.
    expect(await limiter.acquire(clock.now() + 120_000)).toBe(true);
    expect(clock.slept).toEqual([60_000]);
  });

  it('serialises concurrent callers so the window holds under Promise.all', async () => {
    const clock = fakeClockForTests();
    const limiter = new SlidingWindowLimiter(3, 60_000, clock);
    await Promise.all(Array.from({ length: 6 }, () => limiter.acquire()));
    expect(clock.slept).toEqual([60_000]);
  });
});
