# Failure Injection

Iron Monkey supports six injection modes via the repeatable `--inject` flag: `missing`, `malformed`, `out-of-order`, `late`, `duplicate`, and `abort`.

## Syntax

```
--inject <type>:<event-id>[:<args>...]
```

`<event-id>` is the `workflowEventId` visible in the manifest (use `--manifest-out` or `dry-run` to see them). IDs are derived from the event's `noun.verb` — for example, `dev.cdevents.build.started.0.3.0` becomes `build-started`. If the same noun.verb appears more than once, collisions are resolved with a numeric suffix (`pipelinerun-started`, `pipelinerun-started-1`, …). Expression bundle events with an explicit `id:` field use that ID directly (e.g. `testcase-1-started`, `testcase-2-finished` from the bundled `verify` expressions).

## Targeting sub-chains

Injections may target events on **any** chain — the main chain or any detached / concurrent-branch sub-chain — so you can deliberately break a parallel stream (the Chaos Monkey move: withhold or stall a detached chain and watch the receiver's babysitter flag a chain that never started or hung). The `<event-id>` is matched against `workflowEventId` first, then `treePath`.

Because each chain allocates its own `workflowEventId`s, the same id can appear on more than one chain. To target an event unambiguously, use its `treePath` (the axis-prefixed binding key, e.g. `p3.p1.p0.d0.p0`) instead:

```bash
# withhold the first event of a detached chain
iron-monkey run demo.yaml --inject missing:p3.p1.p0.d0.p0
```

Structural injections (`out-of-order`, `duplicate`) act within the chain that owns the targeted event — they reorder/duplicate inside that sub-chain, not the main sequence.

## Modes

### missing

Skips emission of the named event entirely.

```
iron-monkey run demo.yaml --inject missing:build-started
```

### malformed

Corrupts the event payload before emission. The event still fires; it just fails schema validation downstream.

```
--inject malformed:<event-id>:<malformation>[:<field-path>[:<value>]]
```

Malformation types:

| Malformation                            | Description                                     |
| --------------------------------------- | ----------------------------------------------- |
| `missing-required-field:<field-path>`   | Drop a required field                           |
| `wrong-type:<field-path>:<bad-type>`    | Coerce field to wrong JSON type                 |
| `extra-field:<field-path>:<value>`      | Add a field where additionalProperties is false |
| `invalid-enum:<field-path>:<bad-value>` | Use a value outside an enum                     |
| `bad-uuid:<field-path>`                 | Replace a UUID with an invalid string           |
| `broken-chainid`                        | Strip or corrupt the chainId                    |
| `broken-link:<index>`                   | Corrupt the embedded link at the given index    |

Field paths use dot notation. Valid paths depend on the event type — check the schema for what fields exist. Common examples:

```
context.source
context.chainId
subject.id
subject.content.outcome
subject.content.environment.id
```

Because CDEvent schemas use `additionalProperties: false`, injecting `extra-field` or `wrong-type` will produce a payload that fails downstream schema validation by design.

Example:

```bash
iron-monkey run demo.yaml \
  --inject malformed:testsuiterun-finished:invalid-enum:subject.content.outcome:bogus
```

### out-of-order

Moves an event to a new position in the emission sequence.

```
--inject out-of-order:<event-id>:<new-position>
```

Position is 0-indexed. Example — move `artifact-published` to position 2:

```
--inject out-of-order:artifact-published:2
```

### late

Adds extra delay (in milliseconds) before the named event fires.

```
--inject late:<event-id>:<delay-ms>
```

Example — delay `deployment-finished` by 30 seconds:

```
--inject late:deployment-finished:30000
```

### duplicate

Emits the event twice (original followed immediately by a copy).

```
--inject duplicate:<event-id>
```

### abort

Fails the execution **at** that event, which is the shape a real pipeline
failure has: earlier events emitted, this one errored, everything after it
never reached. Distinct from `missing`, which withholds one event and lets the
run continue.

```
abort:<eventId>[:<reason>]
```

```bash
--inject abort:build-finished:disk full
--inject abort:build-finished            # reason defaults to "simulated execution failure"
```

The execution reports `status: "failed"` to an expiry inquiry, and — unlike a
withheld event — nothing it produced is offered for backfill: events after the
abort were never produced, so they appear as `pending` with the reason _"not
reached: the execution aborted before this event"_. This is the declarative
form of the bench's "fail execution X" scenario; see
[EXECUTION-INQUIRY.md](EXECUTION-INQUIRY.md).

## Combining injections

Injections are applied in the order given and compose freely:

```bash
iron-monkey run demo.yaml \
  --inject out-of-order:artifact-published:2 \
  --inject late:deployment-finished:30000 \
  --inject missing:build-started
```

## Auditing

Every injection applied is recorded on the targeted event's `injections` array — under `events[].injections` for the main chain, or `detachedChains[].events[].injections` for a sub-chain. Use `--manifest-out` to save the manifest and inspect what actually happened:

```bash
iron-monkey run demo.yaml \
  --config config.yaml \
  --no-conduit \
  --inject missing:build-started \
  --manifest-out run.json
```
