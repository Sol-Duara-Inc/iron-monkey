/**
 * @module manifest/timing
 * Allocates absolute emission timestamps for manifest events. Each call to
 * {@link TimingAllocator.nextEmitTime} advances an internal clock by a delay
 * derived from the event's `min_wait_ms` / `timeout_ms` budget, producing a
 * watchable default cadence. {@link TimingAllocator.nextExactEmitTime} advances
 * by a precise interval for the `--interval` override. A numeric seed makes the
 * full timing sequence (including jitter) deterministic for replay.
 */

/**
 * Floor for the cadence "base". `min_wait_ms` below this is treated as a
 * dedup / debounce hint rather than an emission target, so the base is clamped
 * up to 100ms before the cadence is computed.
 */
export const MIN_BASE_MS = 100;

/**
 * The shortest delay the default cadence will ever schedule, after jitter.
 * Guarantees a run is watchable by default — events never stream past faster
 * than a human can follow. Falls out naturally for the common case
 * (base = 100 → 10× base = 1000 → −10% jitter = 900), and is enforced as a
 * hard floor for tighter inputs.
 *
 * NOTE: for a workflow that declares `timeout_ms < 900`, this floor can push a
 * scheduled emit past the event's own breach budget. That only happens when an
 * author deliberately sets a sub-900ms timeout (the default is 5000ms); such a
 * workflow should pass an explicit `interval` override instead.
 */
export const MIN_DEFAULT_DELAY_MS = 900;

/** Half-width of the per-event jitter window, as a fraction of the target. */
const JITTER_FRACTION = 0.1;

/**
 * Allocates monotonically increasing `targetEmitTime` values (epoch ms) for
 * consecutive manifest events.
 *
 * The default cadence (see {@link TimingAllocator.nextEmitTime}) derives a
 * per-event delay from the declared `min_wait_ms` / `timeout_ms` budget rather
 * than sampling uniformly across the whole `[min_wait, timeout)` range — a
 * uniform draw against the default 5000ms timeout produces wildly uneven
 * spacing (anywhere from ~100ms to ~5s between events), which reads as "only
 * one event came through" before the dashboard can subscribe. In seeded mode a
 * linear-congruential-style pseudo-random function drives the jitter, making
 * the full timing sequence reproducible.
 */
export class TimingAllocator {
  /** Tracks the epoch ms of the last allocated emission time. */
  private lastTime: number;
  private seed: number | undefined;
  private counter = 0;

  /**
   * @param seed - Optional integer seed. When supplied, the jitter applied to
   *   each default-cadence delay is generated deterministically so that
   *   repeated runs produce identical `targetEmitTime` sequences.
   */
  constructor(seed?: number) {
    this.lastTime = Date.now();
    this.seed = seed;
  }

  /**
   * Returns the next scheduled emission time as epoch milliseconds, advancing
   * the internal clock by the default per-event cadence.
   *
   * The cadence is computed as:
   *
   * ```
   * base   = max(minWaitMs, MIN_BASE_MS)
   * target = timeoutMs > 0 ? min(10 * base, (base + timeoutMs) / 2) : 10 * base
   * delay  = max(MIN_DEFAULT_DELAY_MS, round(target * (1 ± JITTER_FRACTION)))
   * ```
   *
   * `10 * base` gives a comfortable multiple of the debounce floor; the mean of
   * `base` and `timeoutMs` keeps the cadence under the breach budget for tight
   * timeouts. The smaller of the two wins. A ±10% jitter displaces each delay
   * so a run reads organically rather than metronomically, and the result is
   * floored so emission is always watchable by default.
   *
   * @param minWaitMs - Declared minimum inter-event wait (debounce hint).
   * @param timeoutMs - Declared breach budget for the event. `<= 0` means "no
   *   timeout declared" — the mean term is dropped and `10 * base` is used.
   * @returns Absolute epoch milliseconds at which this event should be emitted.
   */
  nextEmitTime(minWaitMs: number, timeoutMs: number): number {
    this.lastTime += this.defaultDelay(minWaitMs, timeoutMs);
    return this.lastTime;
  }

  /**
   * Returns the next scheduled emission time as epoch milliseconds, advancing
   * the internal clock by an exact interval. Used by the `--interval` override
   * (and the playground's interval input): the operator asked for a precise
   * cadence, so no jitter or flooring is applied — `intervalMs` is honored
   * verbatim (clamped to a non-negative integer).
   *
   * @param intervalMs - Exact delay to add before this event, in ms.
   * @returns Absolute epoch milliseconds at which this event should be emitted.
   */
  nextExactEmitTime(intervalMs: number): number {
    this.lastTime += Math.max(0, Math.round(intervalMs));
    return this.lastTime;
  }

  /**
   * Computes the default per-event delay in ms. See {@link nextEmitTime} for
   * the policy. Pure function of its inputs plus the (seeded) jitter draw.
   */
  private defaultDelay(minWaitMs: number, timeoutMs: number): number {
    const base = Math.max(minWaitMs, MIN_BASE_MS);
    const tenX = base * 10;
    const target = timeoutMs > 0 ? Math.min(tenX, (base + timeoutMs) / 2) : tenX;
    const jittered = target * (1 + this.jitter());
    return Math.max(MIN_DEFAULT_DELAY_MS, Math.round(jittered));
  }

  /**
   * Draws the per-event jitter as a fraction in `[-JITTER_FRACTION,
   * +JITTER_FRACTION)`. Uses the seeded pseudo-random function in deterministic
   * mode or `Math.random` otherwise.
   */
  private jitter(): number {
    const r = this.seed !== undefined ? seededRandom(this.seed, this.counter++) : Math.random();
    return r * (2 * JITTER_FRACTION) - JITTER_FRACTION;
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
  const x = Math.sin(seed * 9301 + counter * 49297 + 233) * 1000003;
  return x - Math.floor(x);
}
