import { describe, it, expect } from 'vitest';
import { TimingAllocator, MIN_BASE_MS, MIN_DEFAULT_DELAY_MS } from '../../src/manifest/timing.js';

/**
 * Collect the per-event delays produced by `count` consecutive
 * {@link TimingAllocator.nextEmitTime} calls. Returns the diffs between
 * successive absolute emit times (i.e. the inter-event delays), so we can
 * assert on the cadence directly without depending on the construction-time
 * baseline.
 */
function defaultDelays(
  alloc: TimingAllocator,
  minWaitMs: number,
  timeoutMs: number,
  count: number,
): number[] {
  const times: number[] = [];
  for (let i = 0; i < count; i++) {
    times.push(alloc.nextEmitTime(minWaitMs, timeoutMs));
  }
  const diffs: number[] = [];
  for (let i = 1; i < times.length; i++) {
    diffs.push(times[i] - times[i - 1]);
  }
  return diffs;
}

describe('TimingAllocator — default cadence', () => {
  it('schedules cdcon-like events (min_wait=100, timeout=5000) at ~1000ms ±10%', () => {
    // base = 100, tenX = 1000, mean = (100+5000)/2 = 2550, target = min = 1000.
    const delays = defaultDelays(new TimingAllocator(7), 100, 5000, 20);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(900);
      expect(d).toBeLessThanOrEqual(1100);
    }
  });

  it('floors sub-100ms min_wait up to the base before computing cadence', () => {
    // min_wait = 50 -> base clamps to 100, so identical to the 100/5000 case.
    const delays = defaultDelays(new TimingAllocator(7), 50, 5000, 20);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(900);
      expect(d).toBeLessThanOrEqual(1100);
    }
  });

  it('uses the mean clamp for a larger min_wait (base=1000, big timeout)', () => {
    // base = 1000, tenX = 10000, mean = (1000+100000)/2 = 50500, target = 10000.
    const delays = defaultDelays(new TimingAllocator(7), 1000, 100000, 20);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(9000);
      expect(d).toBeLessThanOrEqual(11000);
    }
  });

  it('drops the mean term when no timeout is declared (timeout <= 0)', () => {
    // base = 100, no timeout -> target = 10*base = 1000.
    const delays = defaultDelays(new TimingAllocator(7), 100, 0, 20);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(900);
      expect(d).toBeLessThanOrEqual(1100);
    }
  });

  it('never schedules faster than the 900ms floor, even with a tight timeout', () => {
    // base = 100, mean = (100+200)/2 = 150, target = min(1000,150) = 150.
    // Jittered ~135-165, but the floor pins every delay at exactly 900.
    const delays = defaultDelays(new TimingAllocator(7), 0, 200, 20);
    for (const d of delays) {
      expect(d).toBe(MIN_DEFAULT_DELAY_MS);
    }
  });

  it('is deterministic for a given seed', () => {
    const a = defaultDelays(new TimingAllocator(42), 100, 5000, 10);
    const b = defaultDelays(new TimingAllocator(42), 100, 5000, 10);
    expect(a).toEqual(b);
  });

  it('produces a non-constant cadence (jitter is actually applied)', () => {
    const delays = defaultDelays(new TimingAllocator(42), 100, 5000, 30);
    const distinct = new Set(delays);
    expect(distinct.size).toBeGreaterThan(1);
  });

  it('returns monotonically increasing absolute emit times', () => {
    const alloc = new TimingAllocator(1);
    let prev = -Infinity;
    for (let i = 0; i < 10; i++) {
      const t = alloc.nextEmitTime(100, 5000);
      expect(t).toBeGreaterThan(prev);
      prev = t;
    }
  });

  it('exposes the policy constants', () => {
    expect(MIN_BASE_MS).toBe(100);
    expect(MIN_DEFAULT_DELAY_MS).toBe(900);
  });
});

describe('TimingAllocator — exact interval override', () => {
  it('spaces events exactly by the interval with no jitter', () => {
    const alloc = new TimingAllocator(7);
    const times = [0, 1, 2, 3, 4].map(() => alloc.nextExactEmitTime(3000));
    for (let i = 1; i < times.length; i++) {
      expect(times[i] - times[i - 1]).toBe(3000);
    }
  });

  it('allows a zero interval (fire-as-fast-as-possible)', () => {
    const alloc = new TimingAllocator(7);
    const t1 = alloc.nextExactEmitTime(0);
    const t2 = alloc.nextExactEmitTime(0);
    expect(t2 - t1).toBe(0);
  });

  it('rounds fractional intervals to whole milliseconds', () => {
    const alloc = new TimingAllocator(7);
    const t1 = alloc.nextExactEmitTime(1000.4);
    const t2 = alloc.nextExactEmitTime(1000.4);
    expect(t2 - t1).toBe(1000);
  });

  it('clamps negative intervals to zero', () => {
    const alloc = new TimingAllocator(7);
    const t1 = alloc.nextExactEmitTime(-500);
    const t2 = alloc.nextExactEmitTime(-500);
    expect(t2 - t1).toBe(0);
  });
});
