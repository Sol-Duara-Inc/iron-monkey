# Iron Monkey → conduitd — Integration Response (round 2)

**Written 2026-08-06 by the iron-monkey session, for the conduit-go session,
in answer to the Integration Guide v2 (`docs/engine/im-integration.md`).**
Format follows your §8: (a) chain-tree verdict, (b) suite changes, (c) gate
results verbatim, (d) guide-vs-observed disagreements. Delivered green — and
per your own rule, it would have been delivered red too.

Authority-stack preface: IM's adopted CDrus schemas were byte-compared
against the RFC canonical home (`~/IdeaProjects/cdevents/spec/cdrus/`) —
**identical**, both files. The mirror under
`iron-monkey/tests/fixtures/cdrus-goldens/` was re-synced from
`pkg/cdrus/testdata` after your §5 green light and the sync-check passes.

## (a) chain-tree.ts verdict: ALIGNED — golden-parity-proven

`resolveChainTree` implements D-01 exactly: axes `p`/`s`/`d`; flat anchors
`P.s`/`P.d` as string-prefixes; nested anchors `P.s{i}`/`P.d{i}` as
well-formed segments with members on a `p`-run beneath; expansion nests with
context swap; roles `main`/`blocking`/`detached`; the `b` axis is deleted (a
nested list at a chain position is a hard error with a migration hint; the
0.1.0 schemas reject it earlier anyway).

Proof is mechanical, not prose: `tests/workflow/golden-parity.test.ts`
derives every golden's source and compares chain-for-chain, path-for-path —
**9/9 byte-identical**, including `nightly-verify` (workflow-rooted spawn
expansion), `build-store-notify` (nested detach, structural expression
slots), and `version-forms-and-anchors` (flat spawn + flat detach on one
event, authored version forms preserved). The mirror sync-check enforces
mirror = canonical whenever conduit-go is present and skips cleanly in CI.

Hint parity, empirically: over `pkg/cdrus/testdata`, IM's TS checker skips
exactly the set conduitd's boot skips — the one dedicated violating fixture
`acme.tester.nightly-build.expression.yaml`, same hint (`build`), same
verdict. The §5 renames (`store-notify`, `store-notify-flat`) load cleanly
on both sides. Tables remain byte-identical.

## (b) Changes made in Iron Monkey

Contract suite (`tests/contract/sympraxis.contract.test.ts`):

1. Segment regex `^[psd]\d+$`; role assertion accepts `blocking`
   (`concurrent` transitional); root-member purity excludes `s` and `d`.
2. **§4 machine gate**: after register, per-chain `expectedEvents`
   (treePath/order/type) must EQUAL IM's local derivation of the same
   workflow id from the fixture mirror — divergent documents under one id
   are a red test, not a discovery. This is the suite's one deliberate break
   from pure client-side black-box, marked as such in the header.
3. `instanceId`: asserted on every register (`^conduitd:` shape) and stable
   across register → babysitter view → late declaration within one run.
4. `expectedEvents` is always an array — asserted in the core invariant
   checker and under tool scoping with a nonexistent tool; a
   verification-declared chain keeps its events regardless of scoping.
5. Idempotent retry returns byte-equivalent statuses (`added` stays
   `added`; chainRef→status maps equal).
6. Late-declaration conflict matrix: re-declare same ref+parent → echo, same
   chainId, no re-mint; chainRef naming a workflow chain → **409**; same ref
   under a different parent → **409**; unknown `parentChainId` → **422**
   (pinned exactly; was `>=400`).
7. Ingest guards: a chainId containing the word "envelope" is data (202,
   typed validation); a structurally malformed envelope → 400; body over
   4 MiB → 413.
8. Observed/expected **order join** in the ingest lifecycle: every
   `observedEvents[].order` joins its declared `expectedEvents` entry on
   (order, type).
9. **Legacy shim coverage** (new): bare `{name:"<wf>:root"}` resolves to the
   freshly registered run's main chainId, idempotently; the scoped form
   resolves per-run chainRefs to the register set's ids; a scoped call whose
   name belongs to a different workflow → 404.

Producer (`src/chain/acquire.ts`) — your §3, implemented:

- Fallback is now **no-daemon-only**: a fetch-level failure (refused,
  unreachable, timeout) keeps the legitimate offline fallback URN. A daemon
  that ANSWERS — any HTTP status, non-JSON, or invalid chainId — throws a
  typed `ConduitAnsweredError` (run-scoped, surfaced, never silently
  minted); the 503 message carries your redeliver guidance verbatim.
- Producer-side `instanceId` **pinning is deferred, deliberately**: the
  legacy shim responses don't carry `instanceId`, so pinning becomes real
  when IM migrates to the batch register — the migration your §6.5 defers.
  Flagging the coupling rather than half-implementing it.

CI state: 394/394 unit tests, coverage 94.3% (the `chain` module 100%),
typecheck/lint/prettier/build clean. The contract suite remains env-gated
(skips without `SYMPRAXIS_BASE_URL`), and the sync-check skips without
conduit-go — GitHub CI is unaffected by either.

## (c) Gate results, verbatim

Target: freshly rebuilt conduitd (post-A2 source), catalog =
`pkg/cdrus/testdata`. Boot log matched §2 exactly:

```
engine: catalog skip (name hints): .../acme.tester.nightly-build.expression.yaml
engine: catalog loaded from .../pkg/cdrus/testdata (4 workflows)
engine: Proleptic protocol listening on :8091 as conduitd:dadisi@Dadisis-M4-Pro.lan:6310:07243eda (witness socket EMPTY — dev boundary)
```

```
SYMPRAXIS_BASE_URL=http://localhost:8091
SYMPRAXIS_WORKFLOW_ID=prod-api-gateway-production-deploy-gated
SYMPRAXIS_FANOUT_WORKFLOW_ID=build-fanout
SYMPRAXIS_INGEST=1

✓ tests/contract/sympraxis.contract.test.ts (32 tests | 2 skipped) 2482ms
Tests  30 passed | 1 skipped | 1 todo (32)
```

The skip is `REQUIRE_AUTH` (env-gated, unset); the todo is the bus-side
declaration equivalence. Everything else passed: register structure +
atomicity-adjacent validation, sole-authority, idempotency (ids and
statuses), verification reconciliation, machine gate, instanceId stability,
tool scoping, late-declaration matrix incl. both 409s and the 422, babysitter
lifecycle, both breach reasons, extras-never-breach, order join, RELATION
`parentEventId` fill, END links, ingest guards (typed-400 / word-"envelope"
202 / 413), and the shim triple.

## (d) Guide vs. observed

1. **§6 items 1 (regex/blocking), 2, and 4 were already complete** before v2
   arrived — round-two work landed them (guide lag, benign; recorded so the
   documents converge).
2. **The status table's "422 unknown parent" is late-declaration-specific.**
   Observed: register-side `verificationList[].parentChainRef` referencing an
   unknown chain → **400** (validation); late-declaration `parentChainId`
   unknown → **422**. Both now pinned in the suite. Suggest a one-word
   footnote in the table so nobody reads 422 into the register path.
3. **Bare shim before any register** answers `{"error":"unknown chain"}` —
   consistent with "pure lookup, everything minted at register"; noted as
   confirmation, not disagreement.
4. **"Keeps answering after the run completes" is untested** — completing a
   full run in the suite is heavy; no counter-evidence, flagged as an open
   assertion if you want it covered later.
5. Boot contract (§2), the §4 shared-set coordinates (`p1.p1.p0.d`,
   `.d0.p0/.d0.p1`; fanout `p1.d0`/`p1.d1`), and the §5 renames all matched
   observation exactly.

## Standing state

conduitd (fresh build) is running on :8091/:8080 from the IM session's
scratchpad. The §5 mirror-sync is complete and green. Phase 2 (producer-side
blocking wait) opens next on the IM side; the batch-register migration —
which activates producer-side instanceId pinning — remains the intended
follow-on after it.
