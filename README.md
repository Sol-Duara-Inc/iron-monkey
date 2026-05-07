<img src="docs/iron-monkey-logo.png" alt="Iron Monkey logo" width="200" />

A CDEvents pitching machine for testing SDLC orchestration platforms.

Iron Monkey takes a workflow YAML describing a happy path and a set of failure-injection arguments, then fires CDEvents at a configured message bus (RabbitMQ or Kafka) on a controllable schedule.

The name is a nod to Iron Mike (the pitching machine) and Chaos Monkey (Netflix's failure-injection tool).

---

## Sympraxis

Iron Monkey emits **Sympraxis-conformant chains**. Sympraxis is the three-pillared language system of CDEvents (vocabulary), CDrus Expressions (grammar), and Koine DSL (execution). Workflows authored for Iron Monkey follow the CDrus layer — the `$schema` modeline on every workflow YAML points to `cdrus.dev` because the workflow grammar is the CDrus layer of Sympraxis.

A Sympraxis chain is tool-bracketed: each tool's contribution opens with a `pipelineRun.started`, optional `pipelineRun.queued` events signal handoffs between tools, and a single `pipelineRun.finished` closes the chain regardless of how many tools participated.

---

## Requirements

- Node.js 20+ LTS
- npm 9+
- RabbitMQ or Kafka (for `run` / `inspect` / `purge`)

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

# Run against a local RabbitMQ
iron-monkey run examples/workflows/happy-path.yaml \
  --config examples/configs/local-rabbit.yaml \
  --no-conduit --bus default

# Run with failure injection
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
iron-monkey run <workflow.yaml>       Emit events per the workflow
iron-monkey validate <workflow.yaml>  Parse and validate; do not connect to bus
iron-monkey dry-run <workflow.yaml>   Build the manifest, print it, exit
iron-monkey inspect <bus-name>        Show queue/topic depth and bindings
iron-monkey purge <bus-name>          Drain a queue / reset a topic (--confirm required)
iron-monkey version                   Print version and exit
```

### Common flags

```
--config <path>         Path to JSON/YAML config file
--bus <name>            Bus name to use (overrides IRON_MONKEY_BUS_NAME env var)
--no-conduit            Skip chainId acquisition; use fallback URN (no warning)
--seed <int>            Seed for deterministic IDs and timing
--inject <spec>         Failure injection spec (repeatable)
--manifest-out <path>   Write the manifest to file as JSON
--log-level <level>     error | warn | info | debug  (default: info)
--log-format <fmt>      json | text                  (default: json)
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
    routing_key_template: "{eventType}"

  kafka-staging:
    type: kafka
    brokers:
      - kafka-1.local:9092
    topic: cdevents

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

| Variable | Description |
|---|---|
| `IRON_MONKEY_CONFIG` | Path to config file |
| `IRON_MONKEY_SCHEMAS` | Path to CDEvent schemas directory |
| `IRON_MONKEY_CONDUIT_URL` | Conduit base URL |
| `IRON_MONKEY_CONDUIT_TOKEN` | Conduit bearer token |
| `IRON_MONKEY_BUS_NAME` | Bus name to use (must match a key in `buses`) |
| `IRON_MONKEY_BUS_URL` | Bus connection URL (`amqp://` or `kafka://`) |
| `IRON_MONKEY_BUS_USER` | Bus username |
| `IRON_MONKEY_BUS_PASS` | Bus password |
| `IRON_MONKEY_EXPRESSIONS` | Path to expressions directory (default: `expressions/`) |

**Bus selection precedence:** `--bus` CLI flag > `IRON_MONKEY_BUS_NAME` env > config bus named `default` > error if multiple buses and none of the above resolved.

General precedence: CLI args > environment variables > config file > built-in defaults.

---

## Workflow YAML

See [`examples/workflows/happy-path.yaml`](examples/workflows/happy-path.yaml) for a complete 3-tool cross-tool workflow (Jenkins → JFrog → Spinnaker).

A workflow has a flat `produces[]` list. Each item is either a bare `event:` or an `expression:` reference:

```yaml
# yaml-language-server: $schema=https://cdrus.dev/schemas/0.1.0/workflow.schema.json
workflow:
  id: my-workflow
  name: my-workflow
  version: 1
  metadata:
    description: Example
  defaults:
    pipeline: my-pipeline
    timeout_ms: 30000
    min_wait_ms: 100
  produces:
    - event: dev.cdevents.pipelinerun.started.0.3.0
      tool: jenkins-prod
      subject:
        id: run-1

    - expression: build:^0.1.0
      tool: jenkins-prod

    - event: dev.cdevents.pipelinerun.finished.0.3.0
      tool: jenkins-prod
      subject:
        id: run-1
        content:
          outcome: success
```

Key points:
- **No `bus:` field** in workflow YAML — bus is selected via `--bus` flag or env var.
- **No `stages:`** — the list is flat; tool is set per-item or via `workflow.defaults`.
- `workflow.defaults` applies to every item; per-item fields override defaults.
- `tool:` maps to a `tools.*` entry in your config file for source URI resolution. You can also set `source:` directly on any item.
- Event `type:` must exactly match a type string in one of the loaded CDEvent schemas.

---

## Expressions

Expressions are named, versioned bundles of CDEvents that represent common SDLC patterns. They live in the `expressions/` directory and are referenced by `<name>:<semver-range>`.

### Bundled expressions

| Name | Version | Events (in order) |
|---|---|---|
| `build` | `0.1.0` | build.started → testsuiterun.started → testsuiterun.finished → build.finished |
| `artifact-store` | `0.1.0` | artifact.packaged → artifact.published |
| `deploy` | `0.1.0` | taskrun.started → service.deployed → service.published → taskrun.finished |

The `deploy` bundle uses explicit event IDs: `deployment-started` (taskrun.started) and `deployment-finished` (taskrun.finished).

### Referencing an expression

```yaml
- expression: build:^0.1.0
  tool: jenkins-prod
  source: https://jenkins.example.com/
```

All fields on the expression item (`tool`, `source`, `pipeline`, `timeout_ms`, `min_wait_ms`) become defaults for every event inlined from that bundle.

### Overriding individual events

Use `overrides:` to change fields on specific events within an expression. The key is the `noun.verb` of the event type (e.g., `service.deployed`), or the bundle's explicit `id` if one is set:

```yaml
- expression: deploy:^0.1.0
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

1. Create `expressions/<name>-<version>.yaml` following the bundle format in `expressions/build-0.1.0.yaml`.
2. Reference it in your workflow as `expression: <name>:<semver-range>`.

If two events in a bundle share the same `noun.verb`, each must have a unique explicit `id` field or the bundle will fail to load.

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

Every event Iron Monkey emits follows the CDEvents 0.6.0-draft envelope:

```json
{
  "context": {
    "specversion": "0.6.0-draft",
    "id": "<uuid>",
    "source": "<tool-source-uri>",
    "type": "dev.cdevents.<noun>.<verb>.<major>.<minor>.<patch>",
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

`context.links` is a plain array of link objects. The first event in a chain has no `links` entry. After the last event, Iron Monkey emits a standalone `dev.cdevents.chain.end` payload to close the chain.

The fallback chainId (used when `--no-conduit` is set and no Conduit is reachable) takes the form `urn:sol-duara:fallback:<slug>:<timestamp>:<nonce>` — intentionally non-UUID so downstream UUID validators will flag it.

---

## Adding CDEvent schemas

Iron Monkey validates each event against a per-event schema loaded from `schemas/cdevents/`. The loader keys schemas by the type string in `context.type.enum[0]` — filenames don't matter.

To add a new event type:
1. Get the schema from the [CDEvents spec repository](https://github.com/cdevents/spec) or write one following the 0.6.0-draft shape (JSON Schema 2020-12).
2. Drop it in `schemas/cdevents/` (or point `IRON_MONKEY_SCHEMAS` to a custom directory).
3. Use the matching type string in your workflow YAML.

See [docs/SCHEMAS.md](docs/SCHEMAS.md) for the complete schema format requirements.

---

## Development

```bash
npm install
npm run build
npm test                  # unit tests
npm run test:integration  # integration tests (requires RabbitMQ on localhost:5672)
npm run lint
npm run typecheck
```

---

## License

Apache 2.0. See [LICENSE](LICENSE).

Part of the [Sol Duara](https://github.com/solduara) open-source initiative.
