/**
 * @module injection/malformations
 * Implements the individual payload-mutation strategies used by the `malformed`
 * injection type. Each strategy targets a specific class of validation failure
 * that SDLC orchestration platforms should detect and handle.
 *
 * All mutations operate in-place on the supplied payload object using
 * dot-notation field paths (e.g. `'context.source'`, `'subject.content.url'`).
 */

/**
 * Reads a value from a nested object using a dot-notation path.
 * Returns `undefined` if any segment in the path is absent or not an object.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

/**
 * Sets a value at a dot-notation path, creating intermediate objects as needed.
 * Silently does nothing if any existing intermediate is not an object.
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') {
      const o = acc as Record<string, unknown>;
      if (!(key in o)) o[key] = {};
      return o[key];
    }
    return acc;
  }, obj);
  if (target !== null && typeof target === 'object') {
    (target as Record<string, unknown>)[last] = value;
  }
}

/**
 * Deletes the field at the given dot-notation path from a nested object.
 * Silently does nothing if the path does not exist.
 */
function deleteNestedValue(obj: Record<string, unknown>, path: string): void {
  const keys = path.split('.');
  const last = keys.pop()!;
  const target = keys.reduce<unknown>((acc, key) => {
    if (acc !== null && typeof acc === 'object') {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
  if (target !== null && typeof target === 'object') {
    delete (target as Record<string, unknown>)[last];
  }
}

/**
 * Applies a named malformation strategy to a CDEvent payload object.
 *
 * Supported strategies:
 * - **`missing-required-field`** — deletes the field at `fieldPath`, causing a
 *   required-field validation failure.
 * - **`wrong-type`** — coerces the field at `fieldPath` to the type named in
 *   `value` (e.g. `'number'`, `'boolean'`).
 * - **`extra-field`** — adds an unexpected field at `fieldPath` with `value`
 *   as its literal string value.
 * - **`invalid-enum`** — sets the field at `fieldPath` to the invalid enum
 *   string in `value`.
 * - **`bad-uuid`** — replaces the field at `fieldPath` with a known-invalid
 *   UUID string.
 * - **`broken-chainid`** — sets `context.chainId` to the literal string
 *   `'CORRUPTED'`, simulating a chain ID corruption scenario.
 * - **`broken-link`** — corrupts the `target` of the link at index `value`
 *   (default `0`) within `context.links.links`.
 *
 * @param payload - The CDEvent payload object to mutate in-place.
 * @param malformation - Name of the malformation strategy to apply.
 * @param fieldPath - Dot-notation path to the target field (required by most
 *   strategies).
 * @param value - Additional argument whose meaning depends on the strategy
 *   (e.g. type name for `wrong-type`, bad value for `invalid-enum`).
 * @throws {Error} If a required argument (`fieldPath` or `value`) is missing
 *   for the chosen strategy, or if `malformation` is not recognised.
 */
export function applyMalformation(
  payload: Record<string, unknown>,
  malformation: string,
  fieldPath?: string,
  value?: string,
): void {
  switch (malformation) {
    case 'missing-required-field':
      if (!fieldPath) throw new Error('missing-required-field requires a fieldPath');
      deleteNestedValue(payload, fieldPath);
      break;

    case 'wrong-type':
      if (!fieldPath || !value) throw new Error('wrong-type requires fieldPath and bad-type');
      coerceToType(payload, fieldPath, value);
      break;

    case 'extra-field':
      if (!fieldPath || !value) throw new Error('extra-field requires fieldPath and value');
      setNestedValue(payload, fieldPath, value);
      break;

    case 'invalid-enum':
      if (!fieldPath || !value) throw new Error('invalid-enum requires fieldPath and bad-value');
      setNestedValue(payload, fieldPath, value);
      break;

    case 'bad-uuid':
      if (!fieldPath) throw new Error('bad-uuid requires a fieldPath');
      setNestedValue(payload, fieldPath, 'not-a-valid-uuid-!!!');
      break;

    case 'broken-chainid': {
      const ctx = payload.context as Record<string, unknown> | undefined;
      if (ctx) {
        delete ctx['chainId'];
        ctx['chainId'] = 'CORRUPTED';
      }
      break;
    }

    case 'broken-link': {
      const idx = value !== undefined ? parseInt(value, 10) : 0;
      const ctx = payload.context as Record<string, unknown> | undefined;
      if (ctx?.links) {
        const linksObj = ctx.links as Record<string, unknown>;
        const links = linksObj.links as unknown[];
        if (Array.isArray(links) && links[idx]) {
          (links[idx] as Record<string, unknown>)['target'] = 'CORRUPTED';
        }
      }
      break;
    }

    default:
      throw new Error(`Unknown malformation type: '${malformation}'`);
  }
}

/**
 * Replaces the value at `path` within `obj` with a value of the named type.
 * For numeric, boolean, array, and object types a fixed sentinel value is used
 * rather than converting the original, which guarantees a type mismatch.
 *
 * @param obj - Root object to mutate.
 * @param path - Dot-notation path to the field to coerce.
 * @param typeName - Target type name: `'string'`, `'number'`, `'boolean'`,
 *   `'null'`, `'array'`, `'object'`, or any other string (used as a literal).
 */
function coerceToType(obj: Record<string, unknown>, path: string, typeName: string): void {
  const current = getNestedValue(obj, path);
  let coerced: unknown;
  switch (typeName) {
    case 'string':
      coerced = String(current);
      break;
    case 'number':
      coerced = 12345;
      break;
    case 'boolean':
      coerced = true;
      break;
    case 'null':
      coerced = null;
      break;
    case 'array':
      coerced = [];
      break;
    case 'object':
      coerced = {};
      break;
    default:
      coerced = typeName;
  }
  setNestedValue(obj, path, coerced);
}
