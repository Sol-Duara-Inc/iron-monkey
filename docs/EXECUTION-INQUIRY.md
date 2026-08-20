# Execution Inquiry — the producer side of the expiry callback

**Written 2026-08-15 by the iron-monkey session, for the conduit-go session
building the IM plugin.** This is the peer document to
`conduit-go/docs/engine/im-integration.md`. That guide outranks this one:
where they disagree, theirs wins and the disagreement is a finding for
Dadisi — never routed around, never resolved silently.

Scope: what Iron Monkey exposes so that when a TTL expires, Conduit's
`getExecutionStatus(executionID)` inquiry gets a truthful answer. Everything
here implements the two 2026-08-15 addenda.

---

## 1. The decisions, and why

**`executionID` is IM's own run identity** (`Manifest.runId`, the UUID minted
in `src/manifest/builder.ts`). Not a tool-shaped id like `jenkins-prod-1047`.

_Why:_ reachability is not attribution. If execution ids looked tool-native,
Conduit would need a plugin per simulated tool just to know how to _reach_ the
producer — N plugins for one simulator. Every event already carries its own
`tool` and `source` binding, so per-tool **attribution** is preserved on the
wire regardless. What an inquiry needs is **reachability**, which is a property
of the producer. One IM identity, one IM plugin, however many tools a workflow
binds. This is why "Conduit owns the IM plugin" (addendum §2) is singular and
stays singular.

_Consequence:_ IM's local `runId` was previously unused externally. It now has
a job. It exists identically online and offline, which is why it is preferred
over adopting Conduit's minted `runId` — that one does not exist when no
daemon answered, and the id space must not change shape between modes.

**The answer is the truth, including that the failure was simulated.**

_Why (ruled by Dadisi, 2026-08-15):_ there is no value in manufacturing
ambiguity a real tool would have. The inquiry exists to recover what the
execution knows; IM knows precisely, so it says so. A withheld event is
reported as a deliberate simulation, not as a mysterious loss. One response
shape, no tool-faithful/oracle duality, no flag.

**IM can answer `withheld` at all because it pre-allocates.**

_Why this is worth knowing:_ IM builds the entire manifest — every
`context.id`, every PATH/END/RELATION link, every timestamp, every payload —
**before** the first emission. An event IM withheld still exists, fully
formed. A real tool could not hand you the event it never sent. This is the
same property that makes IM able to express a forecast at all.

**Transport is `node:http`; no new dependency.**

_Why:_ the surface is a few read-only JSON routes. IM's runtime dependencies
stay `ajv, ajv-formats, amqplib, commander, js-yaml, kafkajs, pino,
pino-pretty, uuid` — which matters because IM is consumed as a library
(hints, catalog resolver, chain derivation are all exported), and a producer
that drags in a web framework taxes every consumer.

**The server is idle-timed, and that idle timer is IM's linger.**

_Why:_ a callback fires when a TTL expires — up to 20 minutes after the run
on current fixtures — so a process that exits in seconds can never answer.
Default idle timeout is **1 hour**, comfortably past any TTL in play,
configurable, and `0` disables it (a live demo should not die during a long
Q&A). A run in flight vetoes shutdown outright. This is the producer-side
half of the linger question; both ends can now be reasoned about with real
numbers.

---

## 2. The endpoint

```
GET /api/executions/<executionID>
```

Response `200`:

```json
{
  "executionID": "...",
  "status": "queued" | "running" | "finished" | "failed",
  "emitted":  [ { "context": {...}, "subject": {...} } ],
  "withheld": [ { "context": {...}, "subject": {...} } ],
  "detail":   { "...": "additive; see below" }
}
```

The four required fields are exactly as specified in addendum §1. `detail` is
**additive** — ignore it freely. It carries the tool evidence the plugin's
table wants attached on the BREACH→human rows: `workflowId`, Conduit's
`runId` and `instanceId`, `startedAt`/`endedAt`, and per-event records
(`treePath`, `order`, `status`, `plannedAt`, `actualAt`, and a `reason`
string for anything not emitted).

### How `status` is derived

| IM state                                                  | `status`   |
| --------------------------------------------------------- | ---------- |
| manifest built, nothing emitted yet                       | `queued`   |
| at least one emitted, run still in progress               | `running`  |
| run completed; every event terminal (emitted or withheld) | `finished` |
| the run aborted on a bus emit error                       | `failed`   |

A bus emit error **throws and aborts the run** (`src/emitter/runner.ts`) —
that is what `failed` means. Events after the abort are left `pending`; see
the distinction below, it matters.

### `withheld` means deliberately produced and not sent — nothing else

This distinction is not in the addendum and the plugin must not blur it:

- **`withheld`** = the event was fully built and then deliberately not sent
  (a `missing` injection). It is real, complete, and **safe to backfill**.
- **pending-after-abort** = the run died before reaching that event. It was
  never produced. It appears in `detail` with `status: "pending"`, and it is
  **never** in `withheld`.

Backfilling an event the simulated pipeline never reached would inject a
fiction into the record. Only `withheld` is backfillable.

### Status codes

| Code        | Meaning                                     |
| ----------- | ------------------------------------------- |
| `200`       | record found                                |
| `404`       | no execution by that id was ever known      |
| `410`       | known, but the record aged out of retention |
| `401`/`403` | credential configured and missing/wrong     |

`404` and `410` are **answers**, not silence — distinct from the "endpoint
down / hangs" row of the plugin's table. See finding F5 for what `410` should
mean to the plugin.

### Retention

A record stays queryable for at least **its own longest event TTL + the
5-minute inquiry window + 60s slack**, computed per record. The ten-run
window is a _floor_, not a cap: a record inside its inquiry window is never
evicted, even when that pushes the store past ten. See finding F2.

### The daemon — how the callback path gets tested

`iron-monkey serve` is the mode that makes the callback testable end to end.
An inquiry endpoint alone cannot prove the mechanism: proving it means
STARTING a run, WITHHOLDING an event so a TTL really breaches, ASKING what
happened, and TAKING THE ENDPOINT AWAY to exercise the no-answer row. All
four must be drivable from outside the process, so the daemon carries a
control plane.

```
iron-monkey serve [--port 8137] [--host 127.0.0.1] [--token T]
                  [--config im.yaml] [--bus default]
                  [--workflow-root DIR] [--idle-timeout MS]
```

| Route                         | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `POST /api/executions`        | start a run → `202 {executionID, workflowId}`   |
| `GET /api/executions`         | the retained records                            |
| `GET /api/executions/{id}`    | the inquiry answer                              |
| `POST /api/control/go-dark`   | stop answering: `{mode:"5xx"\|"hang", seconds}` |
| `DELETE /api/control/go-dark` | answer again                                    |
| `GET /healthz`                | always answers, even while dark                 |

The trigger body takes `workflow` (required), plus `config`, `bus`, `inject`,
`interval`, `seed`, `noConduit`. It answers `202` as soon as the execution is
RECORDED, not when the run finishes — a run takes minutes and the caller needs
the id immediately to poll the live record.

**Two deliberate asymmetries.** `/healthz` and the control plane keep
answering while dark, because an endpoint you darkened and cannot restore is a
wedged rig, not a test. And `run --serve` has NO control plane — a pitch
answers about itself and nothing more; only the daemon can start runs.
`--workflow-root` constrains triggered paths when the daemon is not purely
local.

### Driving it from the CLI

```
iron-monkey run <workflow.yaml> --serve [--inquiry-port N] [--inquiry-host H]
                                [--inquiry-token T] [--idle-timeout MS]
```

`--serve` is available on `run` and `pitch`. The endpoint starts BEFORE the
run, not after: a TTL early in a long workflow can expire while later events
are still shipping, and the record answers live because the store holds the
manifest by reference. Without `--serve` the CLI exits exactly as it always
has. The URL is written to stdout as well as the log, since the log may be
JSON on another stream and an operator needs the address to configure the
callback.

### Auth

An operator-configured bearer credential is accepted when set; when unset the
server binds loopback only and accepts unauthenticated requests (dev default).
`X-Conduit-On-Behalf-Of` is logged verbatim on every request so the bench can
assert the runner identity arrived.

**Honest scoping:** from IM's side that header is inbound data. IM records it;
IM cannot verify it. The addendum's "impossible for the plugin to forge or
override" is a property of the plugin's position, not an authentication IM
performs. Do not read IM's log line as a security assertion.

---

## 3. Scenario controls

Two of the three the bench needs already exist as **launch-time injections**,
which is better than a runtime API: declarative, reproducible, and recorded in
the manifest.

| Scenario         | Mechanism                                       |
| ---------------- | ----------------------------------------------- |
| withhold event N | `--inject missing:<eventId>` (existing)         |
| fail execution X | `--inject abort:<eventId>[:reason]` (F4, BUILT) |
| go dark          | runtime toggle, bench-only (not built yet)      |

`abort` fails the execution AT that event, which is the shape a real pipeline
failure has: prior events emitted, that one errored, everything after it never
reached. It is deliberately NOT `missing` — a withheld event lets the run
continue and is backfillable; an aborted run's unreached events are neither.

IM's injection vocabulary is `missing | malformed | out-of-order | late |
duplicate | abort`. Any mutation surface (go-dark) sits behind an explicit bench-
controls flag, default off, loopback only: a read-only inquiry endpoint and a
remote-control endpoint deserve different postures.

---

## 4. Findings and recommended rulings

Surfaced per §0 of the integration guide. Each carries a recommendation;
the ruling is Dadisi's.

**F1 — a contract-suite test breaks under the 2026-08-14 sole-authority
ruling, and here it is.** `tests/contract/proleptic.contract.test.ts:921`
emits `envelope-${uuid()}` as a chainId and asserts `202`, proving 400s are
typed rather than text-matched. That id was never issued, so it now gets
`422`. The probe cannot be repaired by planting "envelope" inside a
Conduit-issued id, because IM no longer chooses ids.
_Recommended:_ rewrite the assertion to **`422 not-issued`, explicitly not
`400`**. It still proves typed-not-text-matched validation and additionally
pins the new ruling.

**F2 — ring capacity and retention disagree, and the loser is the inquiry.**
Addendum §3 asks for TTL + 5 min + slack (~30 min on current fixtures); the
store keeps ten runs. A bench doing eleven quick runs evicts run one while its
inquiry window is still open. Conduit then gets no usable answer and breaches
to a human for a harness bookkeeping artifact.
_Recommended:_ ten runs is the floor, the inquiry window wins. Implemented
that way here.

**F3 — the `subject.id` fallback collides across runs.** Conduit captures
`subject.id` from the first `pipelinerun.*` event when registration did not
carry the id. IM's `subject.id` is currently the `workflowEventId` — literally
`"pipelinerun-started"`, identical for every run of that workflow, so the
fallback would assign one identity to all runs.
_Recommended:_ stamp the `executionID` on `pipelinerun.*` subject ids. Safe —
goldens and the register machine gate key on `treePath|order|type`, and
injections key on `workflowEventId`/`treePath`, so nothing that compares
derivations moves. Do this **and** send at register; the fallback exists
precisely for when registration did not carry it. **DONE** — both: the
`executionID` is declared at register, and `pipelinerun.*` subject ids carry
it unless the author set one explicitly.

**F4 — "fail execution X" has no mechanism.** The injection vocabulary has no
way to make a run fail; `failed` today requires a genuine bus error.
_Recommended:_ add an `abort:<eventId>` injection that throws at that event,
producing exactly the real abort shape (prior events emitted, that one
errored, the rest pending). Keeps scenarios declarative and reuses the
existing `--inject` surface.

**F5 — `410` is unmapped in the plugin's table.** It is an answer, not
silence, and it means something specific: the record aged out.
_Recommended:_ treat it as BREACH→human like the no-answer row, but with the
evidence marked "producer record aged out" so the human sees a retention
artifact rather than a pipeline truth.

**F6 — `413` vs `422` precedence is unspecified.** An over-cap body carrying
an unissued chainId could answer either. `proleptic.contract.test.ts:933`
fabricates a UUID for the 413 probe, so its outcome now depends on an order
nobody has ruled.
_Recommended:_ size cap first (cheapest check, and the body may be
unparseable anyway). Whatever is ruled, state it in the guide so a suite can
assert it.

**F7 — on-ramp 2 is not usable by any schema-conformant producer yet.** The
identification rule names `context.workflowId`; the vendored CDEvent schemas
declare `context` as `[chainId, id, links, schemaUri, source, specversion,
timestamp, type]` with `additionalProperties: false`. `workflowId` is absent,
so such an event fails validation before reaching the wire. This resolves with
the link-service rewrite that already carries `workflowID`.
_Recommended:_ note the sequencing in the guide so nobody builds against
on-ramp 2 in the gap and concludes their validator is broken. IM will **not**
patch `context.workflowId` locally — it mirrors the rewritten schema when it
lands, under the same judge model as the catalog and hint table.

**F8 — `executionID` casing is a silent no-op during the transition.** The
capital-`ID` convention is the link-service convention arriving, not a wart —
but the field is optional, so a client sending `executionId` is ignored
without error and the inquiry fails much later for an unrelated-looking
reason. The wire currently carries both conventions side by side.
_Recommended:_ IM asserts the echoed id matches what it sent and fails the run
on mismatch. Cheap insurance that expires when the convergence does.

**F9 — "still running is a non-answer" collides with `late` injections.** A
late-injected event produces exactly that state, and IM knows its scheduled
emit time.
_Recommended:_ the ruling stands; IM attaches the scheduled time in `detail`
so the human sees "due at T+X, deliberately delayed" rather than an
unexplained still-running.

---

## 5. What IM will not do

- **Not invent chain ids.** Sole authority is Conduit's (2026-08-14). IM mints
  fallback URNs only when no daemon answered at all.
- **Not patch shared schemas locally.** Link-service and catalog changes are
  mirrored from canonical, never authored here (F7).
- **Not expose mutation without a flag.** The inquiry endpoint is read-only;
  bench controls are opt-in and loopback-only.
- **Not claim to authenticate `X-Conduit-On-Behalf-Of`.** IM logs it.
