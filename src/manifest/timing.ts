/**
 * @module manifest/timing
 * Allocates absolute emission timestamps for manifest events. Each call to
 * {@link TimingAllocator.nextEmitTime} advances an internal clock by a random
 * delay drawn from the `[min_wait_ms, timeout_ms]` range, simulating realistic
 * pipeline timing. A numeric seed enables deterministic replay.
 */

/**
 * Allocates monotonically increasing `targetEmitTime` values (epoch ms) for
 * consecutive manifest events. The delay between events is sampled uniformly
 * from `[minWaitMs, timeoutMs)`. In seeded mode a linear-congruential-style
 * pseudo-random function is used instead of `Math.random`, making the full
 * timing sequence reproducible.
 */
export class TimingAllocator {
  /** Tracks the epoch ms of the last allocated emission time. */
  private lastTime: number;
  private seed: number | undefined;
  private counter = 0;

  /**
   * @param seed - Optional integer seed. When supplied, timing delays are
   *   generated deterministically so that repeated runs produce identical
   *   `targetEmitTime` sequences.
   */
  constructor(seed?: number) {
    this.lastTime = Date.now();
    this.seed = seed;
  }

  /**
   * Returns the next scheduled emission time as epoch milliseconds. The time
   * is computed by adding a random delay in `[minWaitMs, timeoutMs)` to the
   * previous emission time, ensuring events are always scheduled in the future
   * relative to their predecessors.
   *
   * @param minWaitMs - Lower bound (inclusive) of the inter-event delay in ms.
   * @param timeoutMs - Upper bound (exclusive) of the inter-event delay in ms.
   * @returns Absolute epoch milliseconds at which this event should be emitted.
   */
  nextEmitTime(minWaitMs: number, timeoutMs: number): number {
    const delay = this.randomBetween(minWaitMs, timeoutMs);
    this.lastTime = this.lastTime + delay;
    return this.lastTime;
  }

  /**
   * Draws a random integer from `[min, max)`. Uses a seeded pseudo-random
   * function in deterministic mode or `Math.random` otherwise.
   */
  private randomBetween(min: number, max: number): number {
    if (this.seed !== undefined) {
      const pseudoRand = seededRandom(this.seed, this.counter++);
      return Math.floor(min + pseudoRand * (max - min));
    }
    return Math.floor(min + Math.random() * (max - min));
  }
}

/**
 * A simple seeded pseudo-random number generator returning a value in `[0, 1)`.
 * Based on a sine-based hash combining the seed and counter to produce stable,
 * uniformly distributed values without requiring an external library.
 *
 * @param seed - The run-level seed integer.
 * @param counter - Monotonically increasing counter for the current run.
 * @returns A pseudo-random float in `[0, 1)`.
 */
function seededRandom(seed: number, counter: number): number {
  let x = Math.sin(seed * 9301 + counter * 49297 + 233) * 1000003;
  return x - Math.floor(x);
}
