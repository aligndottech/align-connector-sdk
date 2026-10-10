/**
 * Time and pacing for fetchers: one clock seam, one rate window, one deadline rule, so
 * the fetchers that pace (GitHub search, Linear) and the ones that only honour
 * `timeBudgetMs` cannot disagree about what "out of time" means.
 */

/** The seam a test replaces. Production uses {@link realClock}. */
export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** A clock that never really sleeps: `sleep` advances time and records the wait. */
export function fakeClockForTests(start = 1_700_000_000_000): Clock & { slept: number[]; advance(ms: number): void } {
  let t = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => t,
    sleep: async (ms) => {
      slept.push(ms);
      t += ms;
    },
    advance: (ms) => {
      t += ms;
    },
  };
}

/** The read's deadline, or undefined when the caller set no `timeBudgetMs`. */
export function deadlineFrom(budgetMs: number | undefined, clock: Clock): number | undefined {
  return typeof budgetMs === 'number' && budgetMs >= 0 ? clock.now() + budgetMs : undefined;
}

export function pastDeadline(deadline: number | undefined, clock: Clock): boolean {
  return deadline !== undefined && clock.now() >= deadline;
}

/**
 * At most `max` requests in any `windowMs`: the vendor's own published limit (GitHub
 * search 30/min, Linear 2,500 or 5,000/h). It waits only when the window is full, so a
 * small read never sleeps, and it serialises concurrent callers so `Promise.all` over
 * several searches cannot overrun the window between them.
 */
export class SlidingWindowLimiter {
  private stamps: number[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: Clock = realClock,
  ) {}

  /**
   * Resolves true when one more request fits, after waiting if needed. Resolves false,
   * without waiting, when the wait would end at or past `deadline`: the caller then
   * reports a time_budget skip instead of sleeping through its own budget.
   */
  acquire(deadline?: number): Promise<boolean> {
    const turn = this.chain.then(async () => {
      this.prune();
      if (this.stamps.length >= this.max) {
        const wait = this.stamps[0]! + this.windowMs - this.clock.now();
        if (deadline !== undefined && this.clock.now() + wait >= deadline) return false;
        await this.clock.sleep(wait);
        this.prune();
      }
      this.stamps.push(this.clock.now());
      return true;
    });
    this.chain = turn;
    return turn;
  }

  private prune(): void {
    const floor = this.clock.now() - this.windowMs;
    this.stamps = this.stamps.filter((t) => t > floor);
  }
}
