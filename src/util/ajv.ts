/**
 * @module util/ajv
 * Centralizes Ajv instance construction. Every validator in the codebase needs
 * the same ESM-interop dance — `(Ajv as any).default ?? Ajv` — because Ajv ships
 * a CJS default export that lands under `.default` when imported into ESM. Doing
 * it once here keeps that workaround (and the `ajv-formats` equivalent) in a
 * single place instead of copy-pasted across config, workflow, expression, and
 * CDEvent-schema loaders.
 */

import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// ESM-interop: the CJS default export is nested under `.default` when present.
/* eslint-disable @typescript-eslint/no-explicit-any */
const AjvCtor = (Ajv as any).default ?? Ajv;
const Ajv2020Ctor = (Ajv2020 as any).default ?? Ajv2020;
const addFormatsFn: (ajv: unknown) => void = (addFormats as any).default ?? addFormats;
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Options for {@link createAjv} / {@link createAjv2020}. */
export interface CreateAjvOptions {
  /** Collect all validation errors instead of stopping at the first. Default `true`. */
  allErrors?: boolean;
  /** Ajv strict mode. Omit to use Ajv's default; set `false` to relax. */
  strict?: boolean;
  /** When `true`, registers `ajv-formats` (e.g. `format: "uri"`). Default `false`. */
  formats?: boolean;
}

function buildOptions(opts: CreateAjvOptions): Record<string, unknown> {
  const o: Record<string, unknown> = { allErrors: opts.allErrors ?? true };
  if (opts.strict !== undefined) o.strict = opts.strict;
  return o;
}

/**
 * Creates a draft-07 Ajv instance with the standard interop + options applied.
 *
 * @param opts - Construction options (see {@link CreateAjvOptions}).
 * @returns A ready-to-use Ajv instance.
 */
export function createAjv(opts: CreateAjvOptions = {}): Ajv {
  const ajv = new AjvCtor(buildOptions(opts)) as Ajv;
  if (opts.formats) addFormatsFn(ajv);
  return ajv;
}

/**
 * Creates a draft-2020-12 Ajv instance (for CDEvent JSON schemas), with the
 * standard interop + options applied.
 *
 * @param opts - Construction options (see {@link CreateAjvOptions}).
 * @returns A ready-to-use Ajv 2020 instance.
 */
export function createAjv2020(opts: CreateAjvOptions = {}): Ajv2020 {
  const ajv = new Ajv2020Ctor(buildOptions(opts)) as Ajv2020;
  if (opts.formats) addFormatsFn(ajv);
  return ajv;
}
