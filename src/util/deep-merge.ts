/**
 * @module util/deep-merge
 * Shared recursive deep-merge for plain objects, used by the workflow resolvers
 * (`parser.ts`, `chain-tree.ts`) when layering defaults → item → override
 * `content` blocks in the Proleptic field cascade.
 */

/**
 * Recursively deep-merges two plain objects. Values from `override` win over
 * `base` at every level; nested objects are merged rather than replaced.
 * Arrays and primitives in `override` fully replace the corresponding `base`
 * value. `undefined` values in `override` are ignored (the `base` value is kept).
 *
 * @param base - The lower-priority object (defaults).
 * @param override - The higher-priority object whose values win.
 * @returns A new object; neither input is mutated.
 */
export function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (
      value !== null &&
      value !== undefined &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof result[key] === 'object' &&
      result[key] !== null &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
}
