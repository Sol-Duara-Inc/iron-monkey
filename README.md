<p style="text-align: center;"><a href="https://github.com/Sol-Duara-Inc/iron-monkey/actions/workflows/ci.yml"><img src="https://github.com/Sol-Duara-Inc/iron-monkey/actions/workflows/ci.yml/badge.svg" alt="CI"></a> <img src="https://img.shields.io/github/license/Sol-Duara-Inc/iron-monkey.svg" alt="License"> <img src="https://img.shields.io/github/v/release/Sol-Duara-Inc/iron-monkey.svg" alt="Latest Release"><img src="https://img.shields.io/codecov/c/github/Sol-Duara-Inc/iron-monkey.svg?branch=main" alt="Coverage"> </p>
<img src="docs/iron-monkey-logo.png" alt="Iron Monkey logo" width="200" />

A CDEvents pitching machine for testing SDLC orchestration platforms.

Iron Monkey takes a workflow YAML describing a happy path and a set of failure-injection arguments, then fires CDEvents at a configured message bus (RabbitMQ, Kafka, or Junction Box over HTTP) on a controllable schedule. Workflows and bundled expressions only need to describe the _shape_ of the happy path — Iron Monkey's payload synthesizer fills in any required `subject.content` fields that the schemas demand but the author omitted.

The name is a nod to Iron Mike (the pitching machine) and Chaos Monkey (Netflix's failure-injection tool).

---

## Sympraxis

Iron Monkey emits **Sympraxis-conformant chains**. Sympraxis is the three-pillared language system of CDEvents (vocabulary), CDrus Expressions (grammar), and Koine DSL (execution). Workflows authored for Iron Monkey follow the CDrus layer — the `$schema` modeline on every workflow YAML points to `cdrus.dev` because the workflow grammar is the CDrus layer of Sympraxis.

A Sympraxis chain is tool-bracketed: each tool's contribution opens with a `pipelineRun.started`, optional `pipelineRun.queued` events signal handoffs between tools, and a single `pipelineRun.finished` closes the chain regardless of how many tools participated.

---

## Requirements

- Node.js 20+ LTS
- npm 9+
- One of: RabbitMQ, Kafka, or a reachable Junction Box instance (for `run` / `pitch` / `inspect` / `purge`)

---

## Installation

```bash
npm install -g iron-monkey
```

Or run from source:

```bash
git clone https://github.com/solduara/iron-monkey.git
cd iron-monkey
npm install
npm run build
npm link
```

---

## Quick start

```bash
# Validate a workflow without connecting to any bus
iron-monkey validate examples/workflows/happy-path.yaml \
  --config examples/configs/local-rabbit.yaml

# Dry-run: build and print the event manifest, do not emit
iron-monkey dry-run examples/workflows/happy-path.yaml \
  --no-conduit --bus default

# Dry-run a single expression inline
iron-monkey dry-run examples/workflows/happy-path.yaml \
  --no-conduit --bus default --seed 42

# Pitch a single workflow against a local RabbitMQ
iron-monkey run examples/workflows/happy-path.yaml \
  --config examples/configs/local-rabbit.yaml \
  --no-conduit --bus default

# Pitch multiple workflows simultaneously (each runs independently)
iron-monkey run examples/workflows/happy-path.yaml \
            examples/workflows/sample.yaml \
            examples/workflows/canary.yaml \
  --config examples/configs/local-rabbit.yaml \
  --no-conduit --bus default

# Pitch a full repertoire — per-workflow options, all thrown at once
iron-monkey pitch --from examples/repertoires/chaos.yaml \
  --config examples/configs/local-rabbit.yaml

# Pitch with failure injection
iron-monkey run examples/workflows/happy-path.yaml \
  --config examples/configs/local-rabbit.yaml \
  --no-conduit --bus default \
  --inject missing:build-started \
  --inject late:deployment-finished:10000

# Save the manifest for auditing
iron-monkey run examples/workflows/happy-path.yaml \
  --config examples/configs/local-rabbit.yaml \
  --no-conduit --bus default \
  --manifest-out run-$(date +%s).json
```

---

## Commands

```
iron-monkey run <workflows...>        Pitch one or more workflows (simultaneously if multiple)
iron-monkey pitch --from <file.yaml>  Pitch all workflows in a repertoire YAML simultaneously
iron-monkey validate <workflow.yaml>  Parse and validate; do not connect to bus
iron-monkey dry-run <workflow.yaml>   Build the manifest, print it, exit
iron-monkey inspect <bus-name>        Show queue/topic depth and bindings
iron-monkey purge <bus-name>          Drain a queue / reset a topic (--confirm required)
iron-monkey version                   Print version and exit
```

### Common flags (`run` and `dry-run`)

```
--config <path>         Path to JSON/YAML config file
--bus <name>            Bus name to use (overrides IRON_MONKEY_BUS_NAME env var)
--no-conduit            Skip chainId acquisition; use fallback URN (no warning)
--no-synth              Disable simulated-data synthesis; fail validation on
                        any schema-required field the workflow did not supply
--interval <ms>         Override min_wait_ms and timeout_ms on every event for
                        fixed-cadence emission (e.g. 1000 = one event per second)
--seed <int>            Seed for deterministic IDs and timing
--inject <spec>         Failure injection spec (repeatable)
--manifest-out <path>   Write the manifest to file as JSON
--log-level <level>     error | warn | info | debug  (default: info)
--log-format <fmt>      json | text                  (default: json)
```

### `pitch` flags

```
--from <repertoire.yaml>   Path to the repertoire YAML file (required)
--config <path>            Path to Iron Monkey config file
--log-level <level>        error | warn | info | debug  (default: info)
--log-format <fmt>         json | text                  (default: json)
```

---

## Configuration

Create a YAML or JSON config file. Environment variable interpolation (`${VAR}`) is supported.

```yaml
conduit:
  url: https://conduit.example.com
  token: ${CONDUIT_TOKEN}

buses:
  default:
    type: rabbitmq
    url: amqp://rabbit.local:5672
    auth:
      username: ${RABBIT_USER}
      password: ${RABBIT_PASS}
    exchange: cdevents
    routing_key_template: '{eventType}'

  kafka-staging:
    type: kafka
    brokers:
      - kafka-1.local:9092
    topic: cdevents

  junction-box-local:
    type: junction-box
    url: http://localhost:3000
    # POSTed to /api/launch on connect; the returned runId becomes the chainId.
    workflow_id: junction-box-demo-1
    # health_check: true        # GET /health preflight (default)
    # launch: true              # POST /api/launch (default)
    # events_path: /api/events  # path used for per-event POSTs
    # expected_status: 202      # HTTP status that signals "accepted"
    # headers:                  # forwarded on every request
    #   Authorization: Bearer ${JB_TOKEN}

tools:
  jenkins-prod:
    source: https://jenkins.example.com/
  jfrog-prod:
    source: https://artifacts.example.com/
  spinnaker-prod:
    source: https://spinnaker.example.com/
  gke-prod:
    source: https://gke.example.com/
```

### Environment variables

| Variable                    | Description                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------- |
| `IRON_MONKEY_CONFIG`        | Path to config file                                                                                |
| `IRON_MONKEY_SCHEMAS`       | Path to CDEvent schemas directory                                                                  |
| `IRON_MONKEY_CONDUIT_URL`   | Conduit base URL                                                                                   |
| `IRON_MONKEY_CONDUIT_TOKEN` | Conduit bearer token                                                                               |
| `IRON_MONKEY_BUS_NAME`      | Bus name to use (must match a key in `buses`)                                                      |
| `IRON_MONKEY_BUS_URL`       | Bus connection URL (`amqp://` or `kafka://`). Junction Box buses are configured via the YAML file. |
| `IRON_MONKEY_BUS_USER`      | Bus username                                                                                       |
| `IRON_MONKEY_BUS_PASS`      | Bus password                                                                                       |
| `IRON_MONKEY_EXPRESSIONS`   | Path to expressions directory (default: `expressions/`)                                            |

**Bus selection precedence:** `--bus` CLI flag > `IRON_MONKEY_BUS_NAME` env > config bus named `default` > error if multiple buses and none of the above resolved.

General precedence: CLI args > environment variables > config file > built-in defaults.

---

## Workflow YAML

See [`examples/workflows/happy-path.yaml`](examples/workflows/happy-path.yaml) for a complete 2-tool cross-tool workflow (Jenkins → Spinnaker / GKE).

A workflow has a flat `produces[]` list. Each item is either a bare `event:` or an `expression:` reference:

```yaml
# yaml-language-server: $schema=./schemas/cdrus/workflow.schema.json
workflow:
  id: my-workflow
  name: my-workflow
  cdrus:
    version: 1
    metadata:
      description: Example
  defaults:
    pipeline: my-pipeline
    timeout_ms: 30000
    min_wait_ms: 100
  produces:
    - event: dev.cdevents.pipelinerun.started.0.5.1
      tool: jenkins-prod
      source: https://jenkins.example.com/
      pipeline: my-pipeline

    - expression: build
      tool: jenkins-prod
      source: https://jenkins.example.com/

    - event: dev.cdevents.pipelinerun.finished.0.5.1
      tool: jenkins-prod
      source: https://jenkins.example.com/
      pipeline: my-pipeline
```

Key points:

- **No `bus:` field** in workflow YAML — bus is selected via `--bus` flag or env var.
- **No `stages:`** — the list is flat; tool is set per-item or via `workflow.defaults`.
- `workflow.defaults` applies to every item; per-item fields override defaults.
- `tool:` maps to a `tools.*` entry in your config file for source URI resolution. You can also set `source:` directly on any item.
- Event type strings use CDEvents 0.5.1 versioning — the suffix is always `.0.5.1` for all event types bundled with Iron Monkey (e.g. `dev.cdevents.build.started.0.5.1`).
- **You do not need to spell out every required `subject.content` field.** Iron Monkey synthesizes anything the schema marks `required` but the workflow/bundle omits (see _Payload synthesis_ below). Use `content:` on an event item if you want to pin specific values; everything else is filled in for you.
- The schema version lives under `workflow.cdrus.version`, not at the top level.

---

## Pitching multiple workflows

### `run` — shared options, multiple paths

Pass more than one workflow path to `run` and Iron Monkey pitches them all simultaneously. Each workflow gets its own bus connection, chain ID, and timing. One failure does not abort the others.

```bash
iron-monkey run happy-path.yaml sample.yaml canary.yaml \
  --config local-rabbit.yaml --no-conduit --interval 1000
```

All workflows share the same flags. For per-workflow control use `pitch`.

### `pitch` — a repertoire of pitches

A **repertoire** is a YAML file that maps each workflow to its own options. A `shared` block provides defaults; pitch-level values override them.

```yaml
# chaos.yaml
# yaml-language-server: $schema=./schemas/cdrus/repertoire.schema.json
shared:
  bus: rabbitmq-prod
  interval: 1000

pitches:
  - workflow: examples/workflows/happy-path.yaml
    interval: 500                 # overrides shared

  - workflow: examples/workflows/sample.yaml
    inject:
      - missing:build-started
      - late:deployment-finished:5000

  - workflow: examples/workflows/canary.yaml
    interval: 100
    seed: 42
    bus: local-bus                # overrides shared
```

```bash
iron-monkey pitch --from chaos.yaml --config local-rabbit.yaml
```

**Merge priority** (lowest → highest): `--config` / `--log-level` CLI flags → `shared` → per-pitch values.

Per-pitch fields mirror the common `run` flags:

| Field          | Type       | Description                                      |
| -------------- | ---------- | ------------------------------------------------ |
| `workflow`     | `string`   | Path to the workflow YAML file (**required**)    |
| `bus`          | `string`   | Named bus to target                              |
| `conduit`      | `boolean`  | `false` to skip Conduit chainId acquisition      |
| `interval`     | `number`   | Fixed cadence override in milliseconds           |
| `seed`         | `number`   | Deterministic ID/timing seed                     |
| `inject`       | `string[]` | Failure injection specs                          |
| `manifest_out` | `string`   | Path to write the pre-emission manifest as JSON  |
| `synth`        | `boolean`  | `false` to disable payload synthesis             |

---

## Expressions

Expressions are named bundles of CDEvents that represent common SDLC patterns. They live in the `expressions/` directory and are identified by a three-part tuple: `(group, author, expression)`. A change to an expression's boundary semantics requires a new expression name, not a version bump.

### Bundled expressions

| Expression       | Group       | Author         | Events (in order)                                                             |
| ---------------- | ----------- | -------------- | ----------------------------------------------------------------------------- |
| `build`          | `sol-duara` | `iron-monkey`  | build.started → testsuiterun.started → testsuiterun.finished → build.finished |
| `artifact-store` | `sol-duara` | `iron-monkey`  | artifact.packaged → artifact.published                                        |
| `deploy`         | `sol-duara` | `iron-monkey`  | taskrun.started → service.deployed → service.published → taskrun.finished     |

The `deploy` bundle uses explicit event IDs: `deployment-started` (taskrun.started) and `deployment-finished` (taskrun.finished).

### Referencing an expression

Expressions are referenced by path-style notation — bare name, `author/expression`, or `group/author/expression`. Use the longer form when multiple bundles share the same expression name and Iron Monkey cannot resolve the reference unambiguously.

```yaml
# bare name (unambiguous)
- expression: build
  tool: jenkins-prod
  source: https://jenkins.example.com/

# scoped to author
- expression: iron-monkey/build
  tool: jenkins-prod

# fully qualified
- expression: sol-duara/iron-monkey/build
  tool: jenkins-prod
```

All fields on the expression item (`tool`, `source`, `pipeline`, `timeout_ms`, `min_wait_ms`) become defaults for every event inlined from that bundle.

### Overriding individual events

Use `overrides:` to change fields on specific events within an expression. The key is the `noun.verb` of the event type (e.g., `service.deployed`), or the bundle's explicit `id` if one is set:

```yaml
- expression: deploy
  tool: spinnaker-prod
  source: https://spinnaker.example.com/
  overrides:
    service.deployed:
      tool: gke-prod
      source: https://gke.example.com/
    service.published:
      tool: gke-prod
      source: https://gke.example.com/
```

### Field cascade (most specific wins)

```
workflow.defaults.X
  → produces[i].X  (event-level or expression-level)
    → produces[i].overrides[key].X  (expression events only)
```

The `content` field deep-merges at each level; all other fields are simple replacements.

### Adding a new expression bundle

Create a YAML file anywhere in the `expressions/` directory (filename does not matter) following the flat bundle format:

```yaml
# yaml-language-server: $schema=./schemas/cdrus/expression.schema.json
group: my-org
author: my-tool
expression: my-pattern
produces:
  - event: dev.cdevents.build.started.0.5.1
    timeout_ms: 30000
    min_wait_ms: 100
  - event: dev.cdevents.build.finished.0.5.1
    timeout_ms: 30000
    min_wait_ms: 500
```

Reference it in your workflow as `expression: my-pattern` (or `my-tool/my-pattern` / `my-org/my-tool/my-pattern` if disambiguation is needed).

If two events in a bundle share the same `noun.verb`, each must have a unique explicit `id` field or the bundle will fail to load.

---

## Payload synthesis

CDEvent schemas typically require fields that are noise to hand-author across every event of a long happy path — `outcome` on every `*.finished`, `environment.id` on deploys, `artifactId` on packagings, `pipelineName`/`uri` on every `pipelinerun.started`, and so on. Iron Monkey treats workflows and expression bundles as **intent** (the shape of the chain) and the CDEvent schemas as **contract** (what each event must carry), and synthesizes any required field the intent did not supply.

How it works:

- For each event, the manifest builder loads the matching JSON schema and walks `subject.content`. Anything marked `required` and not supplied by the workflow/bundle is generated.
- **User-supplied values are never overwritten.** Whatever you put in `content:` on an event item (or in a bundle's event content, or in an expression override) wins.
- Generators are semantic where it helps: `outcome: 'success'`, `pipelineName: <workflow.name>`, `artifactId: pkg:oci/<workflow-name>@1.0.0`, `errors: ''`, `source: <toolSource>`. URI-format fields are derived from the configured tool source (`https://jenkins.example.com/synth/<field>/<short-hash>`); when the tool source isn't an absolute URI, an `https://<slug>.synth.iron-monkey.local/` fallback is used. Enums prefer `'success'` when available, else the first declared value.
- Output is deterministic per `(chainId, eventType, JSON pointer)` so repeat runs with the same seed produce identical payloads.
- Every synthesized field is recorded on the manifest event as a JSON pointer in a `synthesized: string[]` array, visible in `dry-run` output and `--manifest-out` files — so you can tell at a glance what was real and what was filled in.

Pass `--no-synth` to disable synthesis and have the schema validator fail loudly on any missing required field. Useful for authoring workflows where you want to know precisely which fields you forgot.

---

## Failure injection

See [docs/INJECTION.md](docs/INJECTION.md) for full reference. Quick examples:

```bash
# Skip an event entirely
--inject missing:build-started

# Corrupt an enum field
--inject malformed:testsuiterun-finished:invalid-enum:subject.content.outcome:bogus

# Move an event out of order
--inject out-of-order:artifact-published:2

# Delay an event
--inject late:deployment-finished:30000

# Emit an event twice
--inject duplicate:build-started
```

Event IDs used in `--inject` specs are the `workflowEventId` values visible in the manifest (e.g., from `--manifest-out`). For events without an explicit subject ID, the ID is derived from the event's `noun.verb` (e.g., `build-started`, `artifact-published`). Bundle events with explicit IDs use those (e.g., `deployment-started`, `deployment-finished`).

---

## CDEvent payload shape

Every event Iron Monkey emits follows the CDEvents 0.5.1 envelope:

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

`context.specversion` is always `"0.5.1"`. The type suffix is also `.0.5.1` for all 45 event types bundled with Iron Monkey.

`context.links` is a plain array of link objects. The first event in a chain has no `links` entry. After the last event, Iron Monkey emits a `dev.cdevents.chain.end` sentinel as a fully-structured CDEvent envelope: `context` carries the type and a single `END` link pointing at the last substantive event, and `subject.id` is the chain ID itself (the chain is the subject of its own closure), with `subject.content.lastEventId` mirroring the END target for consumers that only inspect `subject.content`. This makes the sentinel acceptable to consumers that validate every body against the base CDEvent shape.

The fallback chainId (used when `--no-conduit` is set and no Conduit is reachable) takes the form `urn:sol-duara:fallback:<slug>:<timestamp>:<nonce>` — intentionally non-UUID so downstream UUID validators will flag it.

---

## Adding CDEvent schemas

Iron Monkey validates each event against a per-event schema loaded from `schemas/cdevents/`. The loader keys schemas by the type string in `context.type.enum[0]` — filenames don't matter.

To add a new event type:

1. Get the schema from the [CDEvents spec repository](https://github.com/cdevents/spec) or write one following the 0.5.1 shape (JSON Schema 2020-12).
2. Drop it in `schemas/cdevents/` (or point `IRON_MONKEY_SCHEMAS` to a custom directory).
3. Use the matching type string in your workflow YAML.

See [docs/SCHEMAS.md](docs/SCHEMAS.md) for the complete schema format requirements.

---

## Development

```bash
npm install
npm run build
npm test                  # unit tests
npm run test:coverage     # unit tests with coverage report (80% global threshold)
npm run test:integration  # integration tests (requires RabbitMQ on localhost:5672;
                          # honours IRON_MONKEY_BUS_URL, e.g. amqp://admin:admin@localhost:5672)
npm run lint
npm run typecheck
npm run format:check      # Prettier — CI runs this; use `format` to fix in place
```

---

## License

Apache 2.0. See [LICENSE](LICENSE).

Part of the [Sol Duara](https://github.com/solduara) open-source initiative.
