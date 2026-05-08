/**
 * @module manifest/id-allocator
 * Allocates UUIDs for manifest events. When constructed with a numeric seed the
 * allocator produces the same sequence of IDs on every call (deterministic
 * mode), which is useful for snapshot tests and replay scenarios where event
 * IDs must be stable across runs.
 */

import { v4 as uuidv4 } from 'uuid';

/**
 * Allocates event IDs sequentially. In seeded mode the IDs are derived from a
 * simple hash of the seed and an incrementing counter, producing a stable
 * UUID-shaped string rather than a cryptographically random one. In unseeded
 * mode each call returns a genuine UUID v4.
 */
export class IdAllocator {
  private seed: number | undefined;
  private counter = 0;

  /**
   * @param seed - Optional integer seed. When supplied, {@link nextId} returns
   *   reproducible deterministic UUIDs; when omitted it returns random UUID v4s.
   */
  constructor(seed?: number) {
    this.seed = seed;
  }

  /**
   * Returns the next event ID. In seeded mode the ID is deterministically
   * derived from the seed and current counter; in unseeded mode a random UUID
   * v4 is generated.
   *
   * @returns A UUID-shaped string unique within this allocator's sequence.
   */
  nextId(): string {
    if (this.seed !== undefined) {
      return deterministicUuid(this.seed, this.counter++);
    }
    return uuidv4();
  }
}

/**
 * Produces a UUID-shaped (36-character, hyphen-separated) string derived from
 * `seed` and `counter`. The result is not cryptographically random but is
 * stable: the same `seed`/`counter` pair always yields the same string.
 *
 * @param seed - The run-level seed integer.
 * @param counter - Monotonically increasing index within the current run.
 * @returns A deterministic UUID-formatted string.
 */
function deterministicUuid(seed: number, counter: number): string {
  const s = `${seed}-${counter}`;
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  const hex = (Math.abs(hash) + counter * 0x100000).toString(16).padStart(8, '0');
  const seedHex = seed.toString(16).padStart(4, '0');
  const counterHex = counter.toString(16).padStart(4, '0');
  return `${hex.slice(0, 8)}-${seedHex}-4${counterHex.slice(1)}-a${hex.slice(1, 4)}-${hex}${seedHex}${counterHex}`.slice(
    0,
    36,
  );
}
