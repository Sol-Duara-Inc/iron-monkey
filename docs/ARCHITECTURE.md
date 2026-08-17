# Architecture

## Overview

Iron Monkey is a CLI tool that emits synthetic CDEvents to a message bus. It is designed as a "pitching machine" for testing SDLC orchestration platforms (particularly Conduit / Junction Box).

## Data flow

```
workflow.yaml
    │
    ▼
[workflow/parser.ts]         ← validates against the workflow JSON Schema (CDrus 0.1.0)
    │  WorkflowFile
    ▼
[expressions/loader.ts]      ← loads bundled expression YAML; indexes by identity tuple
    │                         ← name-hint check (RFC §4.1.1): violations skip the bundle
    │  ExpressionRegistry
    ▼
[workflow/chain-tree.ts]     ← resolveChainTree(): expands expression refs, applies the
    │                           binding cascade, lifts spawn/detach into their own chains,
    │                           resolves §6.1 event versions, collects §4.9 anchors
    │  ResolvedChain (a TREE of chains, not a flat list)
    ▼
[chain/register.ts]          ← ONE atomic POST /api/runs: Conduit mints the whole chain
    │                           set and echoes instanceId; declares this run's executionID.
    │                           A fallback URN is minted only when no daemon answers.
    │  RegisterResult
    ▼
[manifest/timing.ts]         ← planTiming(): absolute emit time per event, with §4.7
    │                           blocking waits already folded in
    │  plan
    ▼
[manifest/builder.ts]        ← allocates UUIDs, builds + schema-validates each payload,
    │                           wires PATH/END/RELATION links, stamps targetBus
    │  Manifest
    ▼
[injection/apply.ts]         ← applies --inject specs (missing, malformed, out-of-order,
    │                           late, duplicate, abort)
    │  Manifest (annotated)
    ▼
[emitter/runner.ts]          ← emits on the plan; AWAITS blocking chains before the next
    │                           sibling; detached chains drain without gating anything.
    │                           Records the execution for expiry inquiries.
    ▼
[bus/rabbit.ts|kafka.ts]     ← publishes to exchange / topic
```

The chain's terminator is an **embedded** `END` link on the last event, not a
separate sentinel message (`links/builder.ts` builds it; the runner attaches it
after injections, so it rides whatever envelope actually ships).

## Sympraxis chain

Iron Monkey emits **Sympraxis-conformant chains**. Sympraxis is the three-pillared language system of CDEvents (vocabulary), CDrus Expressions (grammar), and Koine DSL (execution).

In a Sympraxis workflow:

- **Each tool's portion opens with its own `pipelineRun.started` event.** This brackets the tool's contribution to the overall chain.
- **`pipelineRun.queued` is a passive signaling event.** It signals a handoff between tools (e.g., Jenkins notifying JFrog that artifacts are ready for packaging). Iron Monkey emits it **only when explicitly listed** in the workflow YAML — it is never auto-injected at tool boundaries.
- **The workflow ends with a single terminal `pipelineRun.finished`**, regardless of how many tool boundaries appeared.
- **`targetBus`** is stamped on every manifest entry as a seam for future multi-bus support. On day 1, every entry carries the same value (the selected bus name).

A typical 2-tool cross-tool sequence (as in `examples/workflows/happy-path.yaml`) looks like:

```
pipelineRun.started   (tool 1 — Jenkins)
  build.started
  testsuiterun.started
  testsuiterun.finished
  build.finished
  artifact.packaged
  artifact.published
pipelineRun.started   (tool 2 — Spinnaker)
  taskrun.started
  service.deployed
  service.published
  taskrun.finished
pipelineRun.finished  (terminal)
```

`pipelineRun.queued` is available as a handoff signal between tools but is **never auto-injected** — include it explicitly in `produces[]` when needed.

## Key design decisions

**Pre-allocated manifest.** All event IDs, timing, and payloads are computed before any emission. This makes dry-run exact, makes injection deterministic, and provides a single source of truth for what was supposed to happen.

**Per-event schema validation.** Validation runs on the computed payload (after injection for malformed events). Schemas use JSON Schema 2020-12 and are loaded via AJV's 2020-12 draft engine. A malformed injection will cause the affected event to fail validation downstream — that is intentional.

**Schema lookup by type enum, not filename.** The schema loader reads `context.type.enum[0]` from every `.json` file in the schemas directory and builds a `Map<typeString, schema>`. Filenames are irrelevant. This means any schema dropped into the directory is picked up automatically as long as it contains the correct type enum.

**`context.links` is a plain array.** Per the CDEvents 0.6.0-draft spec, `links` in the event context is a `LinkEntry[]` (type + target pairs). The loader pre-registers the `links/embeddedlinksarray` AJV sub-schema so that `$ref` resolution works without a filesystem dependency.

**chainId as first-class citizen.** The chainId flows through every event payload and every log line. The fallback URN is intentionally non-UUID so downstream UUID validators will flag it.

**Bus abstraction.** `Bus` is an interface; `RabbitMQBus` and `KafkaBus` implement it. The `createBus` factory picks the right implementation from config.

## CDEvent payload shape

Every emitted event follows the CDEvents 0.6.0-draft envelope:

```json
{
  "context": {
    "specversion": "0.6.0-draft",
    "id": "<uuid>",
    "source": "<tool-source-uri>",
    "type": "dev.cdevents.<noun>.<verb>.<version>",
    "timestamp": "<iso-8601>",
    "chainId": "<uuid-or-fallback-urn>",
    "links": [
      { "type": "PATH", "target": "<previous-event-id>" }
    ]
  },
  "subject": {
    "id": "<subject-id>",
    "content": { ... }
  }
}
```

The first event in a chain has no `links`. The last event has its `isLast` flag set in the manifest; after it fires, a standalone `dev.cdevents.chain.end` link payload is emitted to the bus.

## Module map

| Module             | Responsibility                                                                                        |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| `src/cli/`         | Commander CLI, command registration, flag parsing                                                     |
| `src/expressions/` | Expression bundle loading, semver resolution, ExpressionRegistry                                      |
| `src/workflow/`    | YAML parsing, schema validation, chain-tree resolution (spawn/detach axes, anchors, §6.2 diagnostics) |
| `src/config/`      | Config file loading, env var merging, `${VAR}` interpolation                                          |
| `src/manifest/`    | Manifest construction, ID allocation, timing                                                          |
| `src/injection/`   | `--inject` spec parsing, payload mutation                                                             |
| `src/chain/`       | Proleptic batch-register client (`POST /api/runs`), fallback URN generator                            |
| `src/links/`       | PATH/END link construction (per Links Proposal)                                                       |
| `src/emitter/`     | Event scheduling, concurrency, bus orchestration                                                      |
| `src/bus/`         | RabbitMQ and Kafka client wrappers                                                                    |
| `src/schema/`      | CDEvent schema loader (type-enum keyed), AJV 2020-12 validator, §6.1 event-version catalog            |
| `src/logger/`      | Pino logger factory                                                                                   |
| `src/execution/`   | Execution records, the inquiry projection, and the HTTP surface behind `serve`                        |
| `src/hints/`       | Name-hint checker (RFC §4.1.1) and its versioned keyword table — isolable                             |
| `src/synth/`       | Simulated-data synthesis for schema-required fields the author omitted                                |
| `src/repertoire/`  | Repertoire YAML loading and per-pitch option merging                                                  |
| `src/util/`        | Shared YAML/AJV helpers and deep-merge                                                                |
