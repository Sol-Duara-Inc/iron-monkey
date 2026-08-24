<p style="text-align: center;"><a href="https://github.com/Sol-Duara-Inc/iron-monkey/actions/workflows/ci.yml"><img src="https://github.com/Sol-Duara-Inc/iron-monkey/actions/workflows/ci.yml/badge.svg" alt="CI"></a> <img src="https://img.shields.io/github/license/Sol-Duara-Inc/iron-monkey.svg" alt="License"> <img src="https://img.shields.io/github/v/release/Sol-Duara-Inc/iron-monkey.svg" alt="Latest Release"></p>
<img src="docs/iron-monkey-logo.png" alt="Iron Monkey logo" width="200" />

A CDEvents pitching machine for testing SDLC orchestration platforms.

Iron Monkey takes a workflow YAML describing a happy path and a set of failure-injection arguments, then fires CDEvents at a configured message bus (RabbitMQ, Kafka, or Junction Box over HTTP) on a controllable schedule. Workflows and bundled expressions only need to describe the _shape_ of the happy path — Iron Monkey's payload synthesizer fills in any required `subject.content` fields that the schemas demand but the author omitted.

The name is a nod to Iron Mike (the pitching machine) and Chaos Monkey (Netflix's failure-injection tool).

---

## Proleptic Event Orchestrator

Iron Monkey emits **Proleptic-conformant chains**. Proleptic Event Orchestrator is the three-pillared language system of CDEvents (vocabulary), CDrus Expressions (grammar), and Koine DSL (execution). Workflows authored for Iron Monkey follow the CDrus layer — the `$schema` modeline on every workflow YAML points to `cdrus.dev` because the workflow grammar is the CDrus layer of Proleptic Event Orchestrator.

A Proleptic chain is tool-bracketed: each tool's contribution opens with a `pipelineRun.started`, optional `pipelineRun.queued` events signal handoffs between tools, and a single `pipelineRun.finished` closes the chain regardless of how many tools participated.

---

## Requirements

- Node.js 20+ LTS
- npm 9+
- One of: RabbitMQ, Kafka, or a reachable Junction Box instance (for `run` / `pitch` / `inspect` / `purge`)

---

## Installation

Iron Monkey is not published to npm yet, so install from source:

```bash
git clone https://github.com/Sol-Duara-Inc/iron-monkey.git
cd iron-monkey
npm install
npm run build
npm link
```

---

## Quick start

```bash
# Validate a workflow without connecting to any bus
iron-monkey validate examples/workflows/prod-payments-blue-green-cutover.yaml \
  --config examples/configs/local-rabbit.yaml

# Dry-run: build and print the event manifest, do not emit
iron-monkey dry-run examples/workflows/prod-payments-blue-green-cutover.yaml \
  --no-conduit --bus default

# Dry-run a single expression inline
iron-monkey dry-run examples/workflows/prod-payments-blue-green-cutover.yaml \
  --no-conduit --bus default --seed 42

# Pitch a single workflow against a local RabbitMQ
iron-monkey run examples/workflows/prod-payments-blue-green-cutover.yaml \
  --config examples/configs/local-rabbit.yaml \
  --no-conduit --bus default

# Pitch multiple workflows simultaneously (each runs independently)
iron-monkey run examples/workflows/prod-payments-blue-green-cutover.yaml \
            examples/workflows/prod-checkout-jenkins-spinnaker-canary.yaml \
            examples/workflows/prod-auth-hotfix-fast-path.yaml \
  --config examples/configs/local-rabbit.yaml \
  --no-conduit --bus default

# Pitch a full repertoire — per-workflow options, all thrown at once
iron-monkey pitch --from examples/repertoires/chaos.yaml \
  --config examples/configs/local-rabbit.yaml

# Pitch with failure injection
iron-monkey run examples/workflows/prod-payments-blue-green-cutover.yaml \
  --config examples/configs/local-rabbit.yaml \
  --no-conduit --bus default \
  --inject missing:build-started \
  --inject late:service-deployed:10000

# Save the manifest for auditing
iron-monkey run examples/workflows/prod-payments-blue-green-cutover.yaml \
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
iron-monkey serve                     Run the daemon: trigger runs over HTTP and answer
                                      Conduit's expiry inquiries
iron-monkey version                   Print version and exit
```

### Common flags (`run` and `dry-run`)

```
--config <path>         Path to JSON/YAML config file
--bus <name>            Bus name to use (overrides IRON_MONKEY_BUS_NAME env var)
--no-conduit            Skip chainId acquisition; use fallback URN (no warning)
--no-synth              Disable simulated-data synthesis; fail validation on
                        any schema-required field the workflow did not supply
--interval <ms>         Emit every event exactly this far apart, overriding the
                        default cadence with fixed, jitter-free spacing
                        (e.g. 1000 = one event per second)
--seed <int>            Seed for deterministic IDs and timing
--inject <spec>         Failure injection spec (repeatable)
--manifest-out <path>   Write the manifest to file as JSON
--log-level <level>     error | warn | info | debug  (default: info)
--log-format <fmt>      json | text                  (default: json)

--serve                 After the run, keep answering Conduit expiry inquiries
                        about it (read-only; no run-triggering — see `serve`)
--inquiry-port <port>   Port for --serve (0 picks a free one)
--inquiry-host <host>   Bind address for --serve (default 127.0.0.1)
--inquiry-token <tok>   Require this bearer credential on inquiries
--idle-timeout <ms>     Quiet window before --serve retires itself; 0 never
                        retires (default 3600000)
```

### `pitch` flags

```
--from <repertoire.yaml>   Path to the repertoire YAML file (required)
--config <path>            Path to Iron Monkey config file
--log-level <level>        error | warn | info | debug  (default: info)
--log-format <fmt>         json | text                  (default: json)

--serve                    After the pitch, keep answering expiry inquiries
--inquiry-port <port>      Port for --serve (0 picks a free one)
--inquiry-host <host>      Bind address for --serve (default 127.0.0.1)
--inquiry-token <tok>      Require this bearer credential on inquiries
--idle-timeout <ms>        Quiet window before --serve retires itself; 0 never
                           retires (default 3600000)
```

### `serve` flags

```
--port <port>              Listen port (default 8137; 0 picks a free one)
--host <host>              Bind address (default 127.0.0.1)
--token <token>            Require this bearer credential on every request
--config <path>            Default Iron Monkey config for triggered runs
--bus <name>               Default bus for triggered runs
--workflow-root <dir>      Restrict triggered workflows to paths inside this dir
--idle-timeout <ms>        Quiet window before the daemon retires itself; 0
                           never retires (default 3600000)
--log-level <level>        error | warn | info | debug  (default: info)
--log-format <fmt>         json | text                  (default: json)
```

---

## Answering Conduit: executions and the expiry inquiry

When a declared event never arrives, Conduit's TTL for that position expires
and it asks the producer what happened. Iron Monkey keeps every run queryable
so it can answer.

Each run has an **executionID** — Iron Monkey's own run identity, declared to
Conduit at registration. One identity per producer, not per simulated tool:
every event still carries its own `tool` binding, so per-tool attribution is
unaffected.

```bash
# Run, then keep answering inquiries about it (read-only)
iron-monkey run examples/workflows/prod-payments-blue-green-cutover.yaml \
  --config examples/configs/local-rabbit.yaml --no-conduit --bus default \
  --inject missing:artifact-signed \
  --serve --inquiry-port 8137
```

```
GET /api/executions/<executionID>
{
  "executionID": "...",
  "status": "queued" | "running" | "finished" | "failed",
  "emitted":  [ { ...full CDEvent envelope... } ],
  "withheld": [ { ...full CDEvent envelope... } ],
  "detail":   { ... per-event evidence ... }
}
```

The answer is truthful, including that a failure was simulated: a withheld
event reports as _"produced but deliberately not sent"_ and carries its full
envelope, because Iron Monkey pre-allocates every payload before deciding
whether to send it. A real tool could not hand you the event it never sent.

**`withheld` and "never reached" are not the same thing.** A withheld event was
built and deliberately suppressed — real, complete, safe to backfill. An event
after an aborted run was never produced at all; it appears in `detail` as
`pending`, never in `withheld`.

The server outlives the run, because a TTL can expire long after the last event
ships. It retires itself after a quiet window (`--idle-timeout`, one hour by
default, `0` to disable), and a run still in flight always vetoes shutdown.

### The daemon

`iron-monkey serve` adds a control plane, so the whole callback path can be
driven from outside the process — start a run, withhold an event, ask what
happened, take the endpoint away:

```bash
iron-monkey serve --port 8137 --config examples/configs/local-rabbit.yaml --bus default
```

```
POST   /api/executions        start a run -> 202 { executionID }
GET    /api/executions        the retained records
GET    /api/executions/{id}   the inquiry answer
POST   /api/control/go-dark   stop answering: { "mode": "5xx"|"hang", "seconds": 30 }
DELETE /api/control/go-dark   answer again
GET    /healthz               always answers, even while dark
```

```bash
curl -X POST localhost:8137/api/executions -H 'Content-Type: application/json' \
  -d '{"workflow":"examples/workflows/prod-payments-blue-green-cutover.yaml",
       "noConduit":true,"interval":200,"inject":["missing:artifact-signed"]}'
```

`/healthz` and the control plane keep answering while dark on purpose — an
endpoint you darkened and cannot restore is a wedged rig. `run --serve` has no
control plane: it answers about its own run and nothing more. Use
`--workflow-root` to confine triggered workflow paths, and `--token` to require
a bearer credential.

Records are kept for the current run plus the last nine — but that count is a
floor, not a cap: a record still inside its inquiry window is never evicted. An
aged-out execution answers `410 Gone`, which is a different fact from `404`
(never known). See [docs/EXECUTION-INQUIRY.md](docs/EXECUTION-INQUIRY.md).

---

## Event type versions

The `event:` field accepts all four CDrus §6.1 forms, resolved against a
vendored CDEvents catalog that is kept byte-identical with Conduit's:

```yaml
- event: dev.cdevents.build.started.0.3.0 # embedded version, exact
- event: 'dev.cdevents.build.started:0.1.1' # colon form, exact (equivalent)
- event: dev.cdevents.build.started # no version -> latest release
- event: 'dev.cdevents.build.started:^0.1.0' # semver range
```

Extension types (`dev.cdeventsx.<tool>-<subject>.<predicate>`) pass through
unresolved. The wire always carries the concrete resolved version; the string
you authored is what chain derivation and registration compare. An unknown type
or an unsatisfiable range fails resolution with the position that caused it.

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

See [`examples/workflows/prod-payments-blue-green-cutover.yaml`](examples/workflows/prod-payments-blue-green-cutover.yaml) for a complete multi-tool production workflow (Jenkins → JFrog → Spinnaker / GKE).

A workflow has a flat `produces[]` list. Each item is either a bare `event:` or an `expression:` reference. Workflows also carry `group` and `author` identity fields that pair with expression authorship for traceability **and drive the resolver** — bare `expression:` references resolve under `(workflow.group, workflow.author, name)` first, falling through to the `example-group / user` standard library when no team-owned bundle exists (see _Referencing an expression_ below):

```yaml
# yaml-language-server: $schema=./schemas/cdrus/workflow.schema.json
workflow:
  id: my-workflow
  group: my-org
  author: my-name
  name: my-workflow
  cdrus:
    version: '0.1.0'
    metadata:
      description: Example
  defaults:
    pipeline: my-pipeline
    timeout_ms: 30000
    min_wait_ms: 100
  produces:
    - event: dev.cdevents.pipelinerun.started.0.3.0
      tool: jenkins-prod
      source: https://jenkins.example.com/
      pipeline: my-pipeline

    - expression: build
      tool: jenkins-prod
      source: https://jenkins.example.com/

    - event: dev.cdevents.pipelinerun.finished.0.3.0
      tool: jenkins-prod
      source: https://jenkins.example.com/
      pipeline: my-pipeline
```

Key points:

- **No `bus:` field** in workflow YAML — bus is selected via `--bus` flag or env var.
- **No `stages:`** — the list is flat; tool is set per-item or via `workflow.defaults`.
- `workflow.defaults` applies to every item; per-item fields override defaults.
- `tool:` maps to a `tools.*` entry in your config file for source URI resolution. You can also set `source:` directly on any item.
- Event type strings follow the CDEvents 0.6.0-draft vocabulary — each event type carries its own independently-versioned suffix (e.g. `dev.cdevents.build.started.0.3.0`).
- **You do not need to spell out every required `subject.content` field.** Iron Monkey synthesizes anything the schema marks `required` but the workflow/bundle omits (see _Payload synthesis_ below). Use `content:` on an event item if you want to pin specific values; everything else is filled in for you.
- The schema version lives under `workflow.cdrus.version`, not at the top level.
- **Emission cadence is derived, not uniform.** By default each event's delay is `min(10 × base, mean(base, timeout_ms))` where `base = max(min_wait_ms, 100)`, displaced by ±10% jitter and floored at 900ms — so a run is watchable by default without firing past a consumer before it can subscribe. `min_wait_ms` defaults to `100` and acts as a debounce floor (sub-100 values clamp up to 100); `timeout_ms` defaults to `5000`. Pass `--interval <ms>` for exact, jitter-free spacing instead.

---

## Pitching multiple workflows

### `run` — shared options, multiple paths

Pass more than one workflow path to `run` and Iron Monkey pitches them all simultaneously. Each workflow gets its own bus connection, chain ID, and timing. One failure does not abort the others.

```bash
iron-monkey run prod-payments-blue-green-cutover.yaml \
               prod-auth-hotfix-fast-path.yaml \
               prod-checkout-jenkins-spinnaker-canary.yaml \
  --config local-rabbit.yaml --no-conduit --interval 1000
```

All workflows share the same flags. For per-workflow control use `pitch`.

### `pitch` — a repertoire of pitches

A **repertoire** is a YAML file that maps each workflow to its own options. A `shared` block provides defaults; pitch-level values override them.

```yaml
# chaos.yaml  (a runnable copy lives at examples/repertoires/chaos.yaml)
shared:
  bus: rabbitmq-prod
  interval: 1000

pitches:
  - workflow: examples/workflows/prod-payments-blue-green-cutover.yaml
    interval: 500 # overrides shared

  - workflow: examples/workflows/prod-auth-hotfix-fast-path.yaml
    inject:
      - missing:build-started
      - late:service-deployed:5000

  - workflow: examples/workflows/prod-checkout-jenkins-spinnaker-canary.yaml
    interval: 100
    seed: 42
    bus: local-bus # overrides shared
```

```bash
iron-monkey pitch --from chaos.yaml --config local-rabbit.yaml
```

**Merge priority** (lowest → highest): `--config` / `--log-level` CLI flags → `shared` → per-pitch values.

Per-pitch fields mirror the common `run` flags:

| Field          | Type       | Description                                     |
| -------------- | ---------- | ----------------------------------------------- |
| `workflow`     | `string`   | Path to the workflow YAML file (**required**)   |
| `bus`          | `string`   | Named bus to target                             |
| `conduit`      | `boolean`  | `false` to skip Conduit chainId acquisition     |
| `interval`     | `number`   | Fixed cadence override in milliseconds          |
| `seed`         | `number`   | Deterministic ID/timing seed                    |
| `inject`       | `string[]` | Failure injection specs                         |
| `manifest_out` | `string`   | Path to write the pre-emission manifest as JSON |
| `synth`        | `boolean`  | `false` to disable payload synthesis            |

---

## Expressions

Expressions are named bundles of CDEvents that represent common SDLC patterns. They live in the `expressions/` directory and are identified by a three-part tuple: `(group, author, expression)`. A change to an expression's boundary semantics requires a new expression name, not a version bump.

Expression files are named `<group>.<author>.<expression>.expression.yaml`. Expressions may compose other expressions inline, and may declare **detached sub-chains** — observable side-chains that the main chain does not wait on (see _Detached sub-chains_ below).

### Bundled expressions

#### example-group / user — standard-library fallback

The resolver consults this catalog whenever a bare `expression:` reference does not resolve under the calling workflow's own `(group, author)`. Every other group is, in effect, layered on top of this one. The catalog is organised by intent:

| Category                    | Expressions                                                                                                                                            |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core CI / CD                | `build`, `deploy`, `verify`, `service-deploy`, `artifact-store`, `pipeline-run`, `ci-pipeline`                                                         |
| Composition / orchestration | `build-deploy`, `build-store`, `build-merge`, `build-queue`, `promote-artifact`, `full-release`, `hotfix`, `task-execute`                              |
| Deployment strategies       | `blue-green-deploy`, `canary-deploy`, `service-rollback`, `service-remove`, `service-upgrade`, `deploy-with-notify`                                    |
| Test patterns               | `test-case`, `test-case-skipped`, `test-output-publish`, `regression-suite`, `verify-with-output`                                                      |
| Artifact lifecycle          | `artifact-sign-publish`, `artifact-distribute`, `artifact-retire`, `build-with-async-scan`                                                             |
| Environments                | `environment-provision`, `environment-update`, `environment-teardown`, `ephemeral-environment`                                                         |
| Change management           | `change-request`, `review-change-request`, `merge-change-request`, `abandon-change-request`, `branch-lifecycle`, `ticket-associate`, `pull-request-ci` |

See `expressions/example-group.user.*.expression.yaml` for the full definitions.

#### sol-duara / dsanyika — core reference library

| Expression              | Events (in order)                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `build`                 | build.started → testsuiterun.started → testsuiterun.finished → build.finished                        |
| `artifact-store`        | artifact.packaged → artifact.published                                                               |
| `deploy`                | taskrun.started → service.deployed → service.published → taskrun.finished                            |
| `verify`                | testsuiterun.started → testcaserun.started → testcaserun.finished → testsuiterun.finished            |
| `artifact-sign-publish` | artifact.packaged → artifact.signed → artifact.published                                             |
| `artifact-distribute`   | artifact.published → artifact.downloaded                                                             |
| `artifact-retire`       | artifact.deleted                                                                                     |
| `blue-green-deploy`     | service.deployed → verify → service.published → service.removed                                      |
| `canary-deploy`         | service.deployed (detach: service-rollback) → verify → service.published                             |
| `service-deploy`        | service.deployed → service.published                                                                 |
| `build-deploy`          | build → deploy                                                                                       |
| `build-merge`           | build → change.merged                                                                                |
| `build-queue`           | build.queued → build.started → build.finished                                                        |
| `build-store`           | build → artifact-store                                                                               |
| `build-with-async-scan` | build → artifact.packaged (detach: artifact.signed → testoutput.published)                           |
| `deploy-with-notify`    | taskrun.started (detach: ticket-associate) → service.deployed → service.published → taskrun.finished |
| `promote-artifact`      | artifact.published → deploy → verify                                                                 |
| `ticket-associate`      | ticket.created → ticket.updated                                                                      |
| `verify-with-output`    | verify → testoutput.published                                                                        |

#### compliance / cstump — stumps (single-event observers)

| Expression          | Events (in order)               |
| ------------------- | ------------------------------- |
| `audit-evidence`    | ticket-trail → service.deployed |
| `change-merged`     | change.merged                   |
| `production-deploy` | service.published               |
| `ticket-trail`      | ticket.created → ticket.updated |

#### spin-dev / shipwreck-sa — enterprise production patterns

| Expression          | Events (in order)                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `build`             | change.merged → build.queued → build.started → verify → testoutput.published → build.finished |
| `artifact-store`    | artifact.packaged → artifact.published                                                        |
| `canary-deploy`     | service.deployed (detach: service-rollback) → verify → service.published                      |
| `deploy`            | taskrun.started → service.deployed → service.published → taskrun.finished                     |
| `build-deploy`      | build → deploy                                                                                |
| `production-deploy` | ticket-associate → deploy                                                                     |
| `service-deploy`    | service.deployed → service.published                                                          |
| `ticket-associate`  | ticket.created → ticket.updated                                                               |
| `verify`            | testsuiterun.started → testcaserun.started → testcaserun.finished → testsuiterun.finished     |

### Referencing an expression

Expressions are referenced by path-style notation — bare name, `author/expression`, or `group/author/expression`. Resolution uses the calling workflow's own `group` and `author` as context:

| Form                       | Resolution attempt order                                                        | Fallback?     |
| -------------------------- | ------------------------------------------------------------------------------- | ------------- |
| `build`                    | 1. `(workflow.group, workflow.author, build)` 2. `(example-group, user, build)` | Yes — std-lib |
| `dsanyika/build`           | `(workflow.group, dsanyika, build)`                                             | No            |
| `sol-duara/dsanyika/build` | `(sol-duara, dsanyika, build)`                                                  | No            |

A bare reference first tries the calling workflow's own identity; if no bundle exists there, it falls through to the `example-group / user` standard-library catalog (see _Bundled expressions_ below). Author-qualified and fully-qualified forms do not fall through — they're an explicit opt-out of the std-lib search.

```yaml
# bare name — resolves under workflow.group/workflow.author first,
# then under example-group/user
- expression: build
  tool: jenkins-prod
  source: https://jenkins.example.com/

# scoped to author within the workflow's group
- expression: dsanyika/build
  tool: jenkins-prod

# fully qualified — no fallback
- expression: sol-duara/dsanyika/build
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

### Detached sub-chains

An event may declare a `detach:` list of events or sub-expressions. A detached list models async security scans, audit notifications, and rollback chains that must be observable but must not block the critical path.

```yaml
produces:
  - event: dev.cdevents.service.deployed.0.3.0
    detach:
      - expression: service-rollback # rollback path is visible but non-blocking
  - expression: verify
  - event: dev.cdevents.service.published.0.3.0
```

`detach` takes two forms (RFC §4.8), never mixed in one list: the **flat form** above declares ONE detached chain (anchored `P.d`, entries at `P.d{i}`); the **nested form** — an array of inner lists — declares one detached chain PER inner list (anchored `P.d{i}`, items on a `p`-run beneath). Either way each detached chain is lifted out of the main linear sequence into **its own chain**. In the built manifest it appears under `detachedChains[]`, each entry carrying:

- its own `chainId` (distinct from the main chain — the unit the observer babysits independently),
- its own internal `PATH` links plus an `END` link on its last event, and
- a `RELATION` link **from the spawning event** in the parent chain **to the detached chain's first event** (`linkKind: TRIGGER`).

The main chain does not wait on a detached chain — the next event in the parent sequence proceeds immediately. At emit time each sub-chain is thrown **fire-and-forget**, anchored at the instant its spawning event is reached (a sub-chain can have no timestamp before the event that triggers it); the run drains all sub-chains before exiting.

### Blocking spawned chains (`spawn`)

Where a detached chain is monitored independently, a **Blocking spawned chain** (RFC §4.7) is monitored _under its parent_: an event's `spawn:` list declares chains the spawning chain **waits on**. Like `detach`, `spawn` takes a flat form (ONE chain, anchored `P.s`) or a nested form (one chain per inner list, anchored `P.s{i}`), never mixed. A nested list directly under `produces` — the pre-0.1.0 "concurrent branch" grammar — is now schema-illegal; spawning always hangs off the triggering event.

```yaml
produces:
  - event: dev.cdevents.testsuiterun.started.0.3.0
    spawn:
      - - event: dev.cdevents.testcaserun.started.0.3.0 # chain p1.s0 — own chainId
        - event: dev.cdevents.testcaserun.finished.0.3.0
      - - event: dev.cdevents.testcaserun.started.0.3.0 # chain p1.s1 — own chainId
        - event: dev.cdevents.testcaserun.finished.0.3.0
  - event: dev.cdevents.testsuiterun.finished.0.3.0
```

Blocking chains are modelled identically to detached chains in the manifest (own `chainId`, `RELATION` from the spawning event, internal `PATH`/`END`) — they appear under `detachedChains[]` with `role: "blocking"`. The difference is **how the receiver monitors them, expressed as breach rollup**:

- a **blocking** chain is monitored under its parent: its breach **rolls up** to the parent, and the spawning chain completes only when its blocking children do — the quiet side of the same rollup;
- a **detached** chain is monitored independently: its breach does **not** roll up.

Iron Monkey emits each spawned chain's events with its own `chainId`; the event is the output. Receiver-side rollup belongs to the observer. The producer-side wait is enforced: a spawning event's next sibling is not emitted until every Blocking chain it spawned has settled, and the timing plan schedules siblings past those chains up front. Detached chains never gate anything. Sibling chains with identical event sequences (e.g. parallel test-case runs) are disambiguated by their distinct `chainId`s, not by content — so the duplicate `testcaserun.*` types never collide on a single cursor.

> Binding key: every manifest event carries an axis-prefixed `treePath` (`p` = produces, `s` = spawn, `d` = detach — e.g. `p1.s0.p1`, `p1.p1.p0.d0.p0`). It is the stable key both producer and observer use to line up "the chain I mean," byte-identical with Conduit's derivation (see `tests/workflow/golden-parity.test.ts`). See `src/workflow/chain-tree.ts`.

#### Chain IDs for sub-chains

Every chain — main, blocking, and detached — gets its **own** chain ID, minted by Conduit in a single atomic batch register when a Conduit service is configured (and `--no-conduit` is not set). A local fallback URN is generated **only when no daemon answers** (unconfigured, unreachable, or timed out) so offline runs are never blocked; if a daemon answers unusably the run fails visibly (`ConduitAnsweredError`) rather than silently minting a non-UUID id that would exit reconciliation. Each sub-chain is registered under the name `<workflow>:<chainRef>` so it is individually addressable, and the `chainIdSource` (`conduit` / `bus` / `fallback`) is recorded on every chain in the manifest.

> One `POST /api/runs` per run mints the entire chain set, keyed by `chainRef`. Before any event is emitted, the producer asserts that the daemon's derivation matches its own — same chains, same `treePath`/`order`/type per chain — so two documents under one workflow id fail loudly rather than being discovered later. The run also declares its `executionID` there, which is how the expiry callback finds it again.

### Adding a new expression bundle

Create a YAML file anywhere in the `expressions/` directory (filename does not matter) following the flat bundle format:

```yaml
# yaml-language-server: $schema=https://cdrus.dev/schemas/0.1.0/expression.schema.json
group: my-org
author: my-tool
expression: my-pattern
description: One-line description of what this pattern represents.
produces:
  - event: dev.cdevents.build.started.0.3.0
    timeout_ms: 30000
    min_wait_ms: 100
  - event: dev.cdevents.build.finished.0.3.0
    timeout_ms: 30000
    min_wait_ms: 500
```

Reference it in your workflow as `expression: my-pattern` (or `my-tool/my-pattern` / `my-org/my-tool/my-pattern` if disambiguation is needed).

Two events in a bundle may share the same `noun.verb` (e.g. two `testcaserun.queued` events to model a two-case suite). Position in `produces` disambiguates them, and unique downstream ids are allocated automatically (`noun-verb`, `noun-verb-1`, `noun-verb-2`, …). Supply an explicit `id` on an event when you want a stable handle for `overrides:` keys or `--inject` spec strings; otherwise the positional default suffices.

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
--inject late:service-deployed:30000

# Emit an event twice
--inject duplicate:build-started

# Fail the execution AT an event: earlier events emit, this one errors, and
# everything after it is never reached (a real pipeline failure's shape)
--inject abort:build-finished:disk full
```

Event IDs used in `--inject` specs are the `workflowEventId` values visible in the manifest (e.g., from `--manifest-out`). For events without an explicit subject ID, the ID is derived from the event's `noun.verb` (e.g., `build-started`, `artifact-published`). Bundle events with explicit IDs use those.

Injections can target events on **any** chain — the main chain or any detached / blocking spawned chain. This is the Chaos Monkey move for parallel streams: withhold (`missing`) or stall (`late`) a detached chain's event and the receiver's babysitter should catch a chain that never started or hung. When the same `workflowEventId` appears on more than one chain, target the exact event by its `treePath` instead (e.g. `--inject missing:p3.p1.p0.d0.p0`); structural injections (`out-of-order`, `duplicate`) act within the chain that owns the targeted event.

---

## CDEvent payload shape

Every event Iron Monkey emits follows the CDEvents 0.6.0-draft envelope:

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

`context.specversion` is always `"0.6.0-draft"`. Each of the 45 bundled event types carries its own version suffix, as defined by the CDEvents vocabulary.

`context.links` is a plain array of link objects following the [CDEvents 0.6.0 embedded-link spec](https://github.com/cdevents/spec/blob/main/links.md). The first event in a chain has no `links` entry. Subsequent events carry a `PATH` link pointing back to the immediately preceding event:

```json
{ "linkType": "PATH", "from": { "contextId": "<previous-event-id>" } }
```

The chain has no separate closing sentinel event. Instead, the **last manifest event** (typically `pipelineRun.finished`) carries an embedded `END` link that self-references its own `context.id`, marking it as the chain's terminator:

```json
{ "linkType": "END", "end": { "contextId": "<this-event-id>" } }
```

Consumers can iterate the events of a chain by walking `PATH.from.contextId` backwards from any point, and they can detect chain closure by looking for an event whose `links` array contains a self-referencing `END`. `START` is intentionally not embeddable per the spec — chain start is inferred from event context.

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
npm run test:coverage     # coverage report (thresholds: 80% lines/statements, 75% branches)
npm run test:integration  # integration tests (requires RabbitMQ on localhost:5672;
                          # honours IRON_MONKEY_BUS_URL, e.g. amqp://admin:admin@localhost:5672)
npm run test:contract     # Proleptic chain-protocol conformance suite (hand-off to the
                          # control-plane engineer; skips unless PROLEPTIC_BASE_URL is set)
npm run lint
npm run typecheck
npm run format:check      # Prettier — CI runs this; use `format` to fix in place
```

---

## License

Apache 2.0. See [LICENSE](LICENSE).

Part of the [Sol Duara](https://github.com/solduara) open-source initiative.
