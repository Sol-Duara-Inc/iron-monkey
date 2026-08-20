# Parent‑Chain Anchoring — resilient sub‑chain correlation

Status: proposed (2026‑05‑28) — **largely superseded, retained for the record
(reviewed 2026‑08‑16).** Its premise was that a sub‑chain could be minted while
the chain service was unreachable, leaving that one chain uncorrelated. Chain
ids are no longer acquired per chain: one atomic `POST /api/runs` mints the
ENTIRE set up front (`src/chain/register.ts`), so a run is either fully
authoritative or fully offline — the partial case the anchor was designed to
survive cannot arise. `context.parentChainId` is NOT emitted; parentage lives
on the manifest's chain records and in the `RELATION` link. Revisit only if
per‑chain acquisition returns (e.g. a bus‑authority path that mints lazily).
Companion to `junction-box/docs/sympraxis-chain-protocol.md`, itself a frozen PoC.
Audience: the Proleptic Event Orchestrator / Junction Box engineer. This describes a small addition
to the emitted CDEvent payload (`context.parentChainId`) and **what the receiver
must do with it** so that sub‑chains stay correctly correlated even when the
chain service was unreachable at the moment their `chainId` was requested.

---

## TL;DR

- Every **sub‑chain** event (detached, concurrent, or late‑declared) is emitted
  carrying **two** anchors in `context`: its own `chainId` **and** its
  `parentChainId`.
- The parent anchor makes correlation **bidirectional and order‑independent**,
  and — critically — lets the receiver **adopt a locally‑minted fallback URN**
  by grafting the orphaned sub‑chain under its already‑known parent.
- Receiver requirement: on an event whose `chainId` the receiver did not mint,
  use `parentChainId` to place it under the parent run and adopt the URN as that
  sub‑chain's identity.

---

## The problem it solves

Proleptic Event Orchestrator is the sole authority for chain UUIDs. Iron Monkey requests a `chainId`
per chain; sub‑chains (a `detach`, a concurrent branch, or a runtime
**late‑declared** chain) each ask for one. When the service is **unreachable at
that moment** — most likely for a late declaration, which is a runtime network
hop — Iron Monkey falls back to a locally‑minted URN
(`urn:sol-duara:fallback:<slug>:<ts>:<nonce>`) so the run is never blocked.

Until now, a child event carried only:

- its own `context.chainId` (the UUID, or the fallback URN), and
- internal `PATH` / `END` links.

The only parent linkage was a **`RELATION` link on the _parent_ event** pointing
forward to the child's first event. That is fine **if** the receiver sees the
parent event, in order, before the child. But a child event seen in isolation —
out of order, after a dropped parent packet, or carrying a URN the receiver never
minted — is an **orphan**: the receiver cannot place it under any run.

That orphan case is exactly where the system is weakest (offline declaration),
so it is exactly the case that must be made robust.

---

## The solution

Emit **`context.parentChainId`** on every sub‑chain event — the `chainId` of the
**immediate** parent chain.

Linkage becomes bidirectional:

| Direction | Where                                                                 | Says              |
| --------- | --------------------------------------------------------------------- | ----------------- |
| forward   | `RELATION` on the **parent** event → child's first event `context.id` | "I spawned this"  |
| backward  | **`parentChainId` on every child event** → parent chain               | "I belong to you" |

The forward link is an optimisation for in‑order delivery; the backward anchor is
the **guarantee**. With it, correlation no longer depends on the receiver having
minted the child's id, nor on having seen the spawning event first.

This is an **invariant**, not a special case: _every_ sub‑chain carries it
(detached, concurrent, and late‑declared alike). Nested chains carry the id of
their immediate parent, so the back‑pointers chain all the way up to the root.

---

## Wire shape

A sub‑chain event:

```jsonc
{
  "context": {
    "specversion": "0.6.0-draft",
    "id": "8f3a…",                       // this event's context.id — Iron Monkey-minted
    "source": "https://…",
    "type": "dev.cdevents.ticket.created.0.2.0",
    "timestamp": "2026-05-28T19:05:02Z",
    "chainId": "urn:sol-duara:fallback:wf-ticket:20260528T190501Z:0dfd53",  // THIS chain (UUID when minted; URN on fallback)
    "parentChainId": "b21c…",            // immediate parent chain (UUID or URN) — the new anchor
    "links": [ { "linkType": "PATH", "from": { "contextId": "…" } } ]
  },
  "subject": { "id": "…", "content": { … } }
}
```

- `chainId` — the sub‑chain's own id. A Proleptic‑minted UUID when the service
  was reachable; a fallback **URN** when it was not.
- `parentChainId` — the immediate parent's `chainId`. **Omitted on the main
  (root) chain** (it has no parent).
- The spawning **parent** event continues to carry the forward `RELATION`
  (`linkKind: "TRIGGER"`, `target.contextId` = child's first event id). Unchanged.

`parentChainId` is present on **every** event of the sub‑chain, not just the
first — so any single event is self‑placeable (tolerant of reordering and loss).

---

## What the receiver must do

For every ingested event, read `context.chainId` (own) and, if present,
`context.parentChainId` (parent):

1. **Known own chainId** → associate normally (existing behaviour).
2. **Unknown own chainId + known parentChainId** → **graft and adopt**: register
   the unknown `chainId` as a sub‑chain **under** `parentChainId`, and associate
   this and all later same‑`chainId` events to it. The URN is a _stable_
   identifier across the chain's events, so adoption is consistent and
   idempotent (adopting the same URN again is a no‑op).
3. **Unknown own chainId + unknown parentChainId** → do **not** drop. Buffer /
   reconcile: the parent's own events carry _their_ `parentChainId`, so the
   hierarchy resolves as soon as any ancestor becomes known. The chain of
   back‑pointers terminates at the **main/root** chain.
4. **Order‑independence**: never require the parent's `RELATION` (or the parent
   event itself) to have arrived before a child event. `parentChainId` alone is
   sufficient to place the child.

The root anchor:

- If the run was registered (normal), the root/main `chainId` is a
  Proleptic‑minted UUID — the whole tree resolves to a known anchor.
- If the **entire run** was offline (root is also a URN), the receiver adopts the
  tree wholesale, keyed by the consistent URNs, when the events arrive.

---

## Why adopting a URN is safe

The fallback URN obeys the protocol's **single‑originator rule**: a chain whose id
Proleptic Event Orchestrator did not mint is originated by the **client** (Iron Monkey) under its
own label, which is exactly what the URN is. It is:

- **consistent** — the same chain yields the same URN on every one of its events
  within a run, so all its events adopt to the same chain; and
- **collision‑safe** — namespaced (`urn:sol-duara:fallback:…`) and never reused
  across chains.

So adoption cannot mis‑merge two chains or clash with a minted UUID. When the
service _was_ reachable, `chainId` is the UUID and no adoption is needed — but
`parentChainId` is still emitted, for order‑independence.

---

## The late‑declared guest, closed

A late‑declared chain (a pipeline that spins up a _separate, unregistered_
pipeline at runtime and declares it just before its first event) is the case most
likely to hit an unreachable service, because the declaration is a live network
hop mid‑run.

- **Declare succeeds** → Proleptic Event Orchestrator received the expected‑events list and minted
  the `chainId`; the guest's events carry that UUID + `parentChainId`.
- **Declare fails** → Iron Monkey mints a URN; the guest's events carry the URN +
  `parentChainId` → the receiver grafts and adopts it under the parent run.

Either way the guest is **observable**. `parentChainId` is what turns a failed
declaration from "lost chain" into "adopted chain."

---

## Boundary: association vs. babysitting (one thing to get right)

`parentChainId` solves **association** — _which run/parent does this event belong
to_. It does **not**, by itself, restore the **expected‑events** contract that a
successful declaration provides.

- A chain adopted via `parentChainId` lets the receiver **observe and graft** the
  events that _do_ arrive.
- But **breach‑on‑absence** (a babysitter alarming that a declared event never
  showed) requires the **expected‑events list**, which only reaches the receiver
  via a successful register/declare.

So when a declaration fails, the receiver still sees and places the guest's
events, but cannot breach it for _missing_ events it was never told to expect.

If full offline babysitting is desired, the complementary mechanism is to carry
the **expected‑events declaration on the guest's first event** (so the receiver
gets the contract even when the declare call failed), or to **re‑declare on
reconnect**. That is a separate, optional addition — flagged here so the receiver
team can decide whether association‑only is sufficient for the failure mode, or
whether the inline‑declaration fallback is also wanted.

---

## Receiver checklist

- [ ] Read `context.parentChainId` alongside `context.chainId` on every event.
- [ ] Graft + adopt an unknown `chainId` under a known `parentChainId`
      (idempotent on the URN).
- [ ] Resolve the hierarchy from `parentChainId` back‑pointers up to the root;
      buffer events whose ancestry isn't known yet rather than dropping them.
- [ ] Treat a fallback URN as a valid, client‑originated chain id (single
      originator) — adopt, don't reject.
- [ ] Decide: is association‑only acceptable on a failed declaration, or is the
      inline expected‑events fallback also required for breach‑on‑absence?
