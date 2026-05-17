/**
 * @module repertoire/types
 * A repertoire is a pitcher's dictionary of workflows to pitch simultaneously.
 * Each pitch targets one workflow YAML and may override any shared run option.
 */

/** Per-workflow pitch configuration. All fields except `workflow` are optional overrides. */
export interface RepertoirePitch {
  /** Path to the workflow YAML file to pitch. */
  workflow: string;
  /** Named bus to target, overriding the shared value. */
  bus?: string;
  /** When `false`, skips Conduit chainId acquisition. */
  conduit?: boolean;
  /** Integer seed for deterministic IDs and timing. */
  seed?: number;
  /** Failure-injection spec strings, e.g. `['missing:build-started']`. */
  inject?: string[];
  /** Write the pre-emission manifest to this path as JSON. */
  manifest_out?: string;
  /** Override every event's `min_wait_ms` and `timeout_ms` with this value. */
  interval?: number;
  /** When `false`, disables simulated-data synthesis. */
  synth?: boolean;
}

/** Shared defaults applied to every pitch unless overridden. */
export interface RepertoireShared {
  /** Named bus to target for all pitches. */
  bus?: string;
  /** When `false`, skips Conduit chainId acquisition for all pitches. */
  conduit?: boolean;
  /** Default interval override applied to all pitches. */
  interval?: number;
  /** When `false`, disables simulated-data synthesis for all pitches. */
  synth?: boolean;
}

/** The top-level structure of a repertoire YAML file. */
export interface RepertoireFile {
  /** Shared defaults merged into every pitch (pitch-level values win). */
  shared?: RepertoireShared;
  /** Ordered list of pitches to throw simultaneously. */
  pitches: RepertoirePitch[];
}
