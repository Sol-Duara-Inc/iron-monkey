/**
 * @module injection/parser
 * Parses failure-injection spec strings into strongly-typed {@link Injection}
 * descriptors. Spec strings use a colon-separated format so they can be passed
 * directly as CLI flag values, e.g.:
 *
 *   `missing:build-started`
 *   `malformed:test-finished:wrong-type:context.source:number`
 *   `out-of-order:deploy-started:0`
 *   `late:artifact-published:5000`
 *   `duplicate:build-queued`
 */

/** All supported failure-injection categories. */
export type InjectionType =
  | 'missing'
  | 'malformed'
  | 'out-of-order'
  | 'late'
  | 'duplicate'
  | 'abort';

/** Marks an event as absent from the emitted stream by setting its status to `'skipped'`. */
export interface MissingInjection {
  type: 'missing';
  /** The `workflowEventId` of the event to suppress. */
  eventId: string;
}

/**
 * Aborts the execution AT this event, as a real pipeline failure does: prior
 * events are emitted, this one errors, and everything after it is never
 * reached. This is the declarative form of the bench's "fail execution X"
 * scenario (docs/EXECUTION-INQUIRY.md F4) — distinct from `missing`, which
 * withholds one event and lets the run continue.
 */
export interface AbortInjection {
  type: 'abort';
  /** The `workflowEventId` of the event at which the execution fails. */
  eventId: string;
  /** Failure message recorded on the event and surfaced by the inquiry. */
  reason: string;
}

/** Corrupts an event payload according to a named malformation strategy. */
export interface MalformedInjection {
  type: 'malformed';
  /** The `workflowEventId` of the event whose payload should be mutated. */
  eventId: string;
  /**
   * Name of the malformation strategy to apply, e.g. `'missing-required-field'`,
   * `'wrong-type'`, `'bad-uuid'`, `'broken-chainid'`. Handled by
   * {@link applyMalformation}.
   */
  malformation: string;
  /**
   * Dot-notation field path within the payload targeted by the malformation
   * (required by most strategies).
   */
  fieldPath?: string;
  /**
   * Secondary argument whose meaning is strategy-dependent (e.g. type name
   * for `wrong-type`, bad enum string for `invalid-enum`).
   */
  value?: string;
}

/**
 * Repositions an event to a different index in the manifest events array,
 * simulating out-of-order delivery to downstream consumers.
 */
export interface OutOfOrderInjection {
  type: 'out-of-order';
  /** The `workflowEventId` of the event to reposition. */
  eventId: string;
  /** Zero-based target index to insert the event at after removal. */
  newPosition: number;
}

/** Adds an artificial delay to an event's scheduled emission time. */
export interface LateInjection {
  type: 'late';
  /** The `workflowEventId` of the event to delay. */
  eventId: string;
  /** Number of additional milliseconds to add to `targetEmitTime`. */
  delayMs: number;
}

/**
 * Inserts an exact deep-copy of an event immediately after the original,
 * simulating duplicate delivery.
 */
export interface DuplicateInjection {
  type: 'duplicate';
  /** The `workflowEventId` of the event to duplicate. */
  eventId: string;
}

/** Discriminated union of all supported injection descriptors. */
export type Injection =
  | MissingInjection
  | MalformedInjection
  | OutOfOrderInjection
  | LateInjection
  | DuplicateInjection
  | AbortInjection;

/**
 * Parses an array of injection spec strings into typed {@link Injection}
 * descriptors. Delegates each item to {@link parseInjection}.
 *
 * @param specs - Array of colon-separated injection specs from CLI `--inject`
 *   flags or programmatic callers.
 * @returns An ordered array of parsed injections ready for {@link applyInjections}.
 * @throws {Error} If any spec string is malformed or references an unknown
 *   injection type.
 */
export function parseInjections(specs: string[]): Injection[] {
  return specs.map(parseInjection);
}

/**
 * Parses a single colon-separated injection spec string into a typed
 * {@link Injection} descriptor. The first segment is the type, subsequent
 * segments carry type-specific arguments.
 *
 * @throws {Error} If the spec is missing required segments or contains an
 *   unrecognised type.
 */
function parseInjection(spec: string): Injection {
  const parts = spec.split(':');
  const type = parts[0] as InjectionType;

  switch (type) {
    case 'missing': {
      if (parts.length < 2) throw new Error(`Invalid missing injection: '${spec}'`);
      return { type: 'missing', eventId: parts[1] };
    }
    case 'malformed': {
      if (parts.length < 3) throw new Error(`Invalid malformed injection: '${spec}'`);
      const eventId = parts[1];
      const malformation = parts[2];
      const fieldPath = parts[3];
      const value = parts[4];
      return { type: 'malformed', eventId, malformation, fieldPath, value };
    }
    case 'out-of-order': {
      if (parts.length < 3) throw new Error(`Invalid out-of-order injection: '${spec}'`);
      const newPosition = parseInt(parts[2], 10);
      if (isNaN(newPosition))
        throw new Error(`Invalid position in out-of-order injection: '${spec}'`);
      return { type: 'out-of-order', eventId: parts[1], newPosition };
    }
    case 'late': {
      if (parts.length < 3) throw new Error(`Invalid late injection: '${spec}'`);
      const delayMs = parseInt(parts[2], 10);
      if (isNaN(delayMs)) throw new Error(`Invalid delay in late injection: '${spec}'`);
      return { type: 'late', eventId: parts[1], delayMs };
    }
    case 'duplicate': {
      if (parts.length < 2) throw new Error(`Invalid duplicate injection: '${spec}'`);
      return { type: 'duplicate', eventId: parts[1] };
    }
    case 'abort': {
      if (parts.length < 2) throw new Error(`Invalid abort injection: '${spec}'`);
      return {
        type: 'abort',
        eventId: parts[1],
        reason: parts.slice(2).join(':') || 'simulated execution failure',
      };
    }
    default:
      throw new Error(
        `Unknown injection type: '${type}'. Valid: missing, malformed, out-of-order, late, ` +
          `duplicate, abort`,
      );
  }
}
