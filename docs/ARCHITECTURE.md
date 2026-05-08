# Architecture

## Overview

Iron Monkey is a CLI tool that emits synthetic CDEvents to a message bus. It is designed as a "pitching machine" for testing SDLC orchestration platforms (particularly Conduit / Junction Box).

## Data flow

```
workflow.yaml
    │
    ▼
[workflow/parser.ts]         ← validates against workflow JSON Schema (Sympraxis CDrus layer)
    │  WorkflowFile
    ▼
[expressions/loader.ts]      ← loads bundled expression YAML files; indexes by name + semver
    │  ExpressionRegistry
    ▼
[workflow/parser.ts]         ← resolveProduces(): inlines expressions, applies defaults cascade
    │  ResolvedEvent[]
    ▼
[chain/acquire.ts]           ← POST /chainID to Conduit (or fallback URN)
    │  chainId
    ▼
[manifest/builder.ts]        ← allocates UUIDs, computes timing, builds CDEvent payloads
    │                         ← loads schemas by type enum; validates each planned event
    │                         ← stamps targetBus on every entry
    │  Manifest
    ▼
[injection/apply.ts]         ← applies --inject specs (missing, malformed, out-of-order, late, duplicate)
    │  Manifest (annotated)
    ▼
[emitter/runner.ts]          ← waits for target times, emits events via bus
    │
    ▼
[bus/rabbit.ts|kafka.ts]     ← publishes to exchange / topic
    │
    ▼
[links/builder.ts]           ← emits standalone END link after last event
```

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

**`context.links` is a plain array.** Per the CDEvents 0.5.1 spec, `links` in the event context is a `LinkEntry[]` (type + target pairs). The loader pre-registers the `links/embeddedlinksarray` AJV sub-schema so that `$ref` resolution works without a filesystem dependency.

**chainId as first-class citizen.** The chainId flows through every event payload and every log line. The fallback URN is intentionally non-UUID so downstream UUID validators will flag it.

**Bus abstraction.** `Bus` is an interface; `RabbitMQBus` and `KafkaBus` implement it. The `createBus` factory picks the right implementation from config.

## CDEvent payload shape

Every emitted event follows the CDEvents 0.5.1 envelope:

```json
{
  "context": {
    "specversion": "0.5.1",
    "id": "<uuid>",
    "source": "<tool-source-uri>",
    "type": "dev.cdevents.<noun>.<verb>.0.5.1",
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

| Module | Responsibility |
|---|---|
| `src/cli/` | Commander CLI, command registration, flag parsing |
| `src/expressions/` | Expression bundle loading, semver resolution, ExpressionRegistry |
| `src/workflow/` | YAML parsing, JSON Schema validation, expression resolution, defaults cascade |
| `src/config/` | Config file loading, env var merging, `${VAR}` interpolation |
| `src/manifest/` | Manifest construction, ID allocation, timing |
| `src/injection/` | `--inject` spec parsing, payload mutation |
| `src/chain/` | Conduit HTTP client, fallback URN generator |
| `src/links/` | PATH/END link construction (per Links Proposal) |
| `src/emitter/` | Event scheduling, concurrency, bus orchestration |
| `src/bus/` | RabbitMQ and Kafka client wrappers |
| `src/schema/` | CDEvent schema loader (type-enum keyed) and AJV 2020-12 validator |
| `src/logger/` | Pino logger factory |
