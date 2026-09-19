# Energy Flow System

## Current state

**Off by data.** The `energyFlow` rule was removed from `data/world_rules.json`, and the `coalGenerator` organ no longer charges energy (inert `overTime`/grants in `data/internalComponents.json`). In every shipped world the per-turn flow step therefore no-ops: no entity enumeration, no stat writes, no broadcast, no log — exactly the "missing key" degradation path the design calls for. Nothing below the this section changes: every "why" here documents a code path that is still intact and still runs every round start; the entire mechanic can be re-activated by editing one data key back into `data/world_rules.json` (`test/contract/energyFlow.contract.test.js` scenario (e) pins the off state and that re-activation).

## 1. Overview

The M1 droid is not a collection of independent batteries. Some of its parts generate energy (the fuel loop), none of the others have a source of their own, and a droid that can move is one organism, not twenty-three silos. The energy flow gives the entity a circulatory system: every round, each component that holds energy shares a fixed fraction of what it *started* the round with with its peers, until the pool has spread evenly through the whole network. Energy is a substance that circulates, not a number each part owns forever.

The flow is a **law of the world**, not an action: it runs at **round start** (the turn-start hook, after the IC per-turn step) and is switched entirely by one key in `data/world_rules.json`. The client needs no flow logic at all — it already renders each component's `Physical.energy` stat bar dynamically, so it simply receives the updated states.

## 2. Why an entity is one fully-interconnected network

Circulation is what makes a generator organ meaningful for the entity as a whole. If energy stayed in its host component, the fuel loop would be a local stat on one part and the rest of the droid would be unrelated. Treating the entity as one network where every component can reach every other component is the design decision that turns "this organ charges this part" into "this organ powers the droid". The flow implements that network as fully interconnected on purpose — there is no geometry, no adjacency, no path: reach is total, so the result never depends on where a part sits in the iteration.

## 3. Why the step is simultaneous (read-all, then write-all)

A sequential pass — each part giving from whatever it *currently* holds — would make the outcome depend on the order parts are visited: energy would cascade down the list and parts earlier in the iteration would be drained differently from later ones. Reading every value at round start and writing every new value at once makes the step order-independent and fair: each part sends from its turn-start holding, receiving and sending from the same frozen picture of the world. That is the only reading of "share a fraction of your energy with the others" that is stable and explainable.

## 4. Why overflow is lost, never re-routed

A part has a capacity — how much it can hold. When its incoming share would push it past that bound, the excess is simply lost: it does not re-route to other parts. Re-routing would make the step iterative, and an iterative redistribution risks looping and turns the balance into a second-order effect nobody can reason about. Losing the overflow at the boundary is the simplest rule that keeps the invariant "a part never exceeds its capacity" absolute. At the shipped scale this loss is a rare, tiny edge case — a design property of the bound, not a balance knob.

## 5. Why a drain is not damage

A part giving away energy is healthy physiology, not injury. The damage pipeline is where *losses* converge — material loss, existence loss — and a shipped world rule watches exactly that pipeline to drop chunks of material when damage happens. If the flow's strict decreases went through the same door, a circulating droid would shed material chunks every single round, bleeding the world's matter stream into pure circulation. So the flow writes its stat changes with the damage event suppressed, while real damage continues to fire the listeners untouched. The two kinds of decrease are different events, and the system keeps them apart at the one place they would otherwise be confused.

## 6. Why per-part capacity is an optional recipe field

How much a part can hold is a property of the part's design, not of the flow. A component recipe *may* declare its own energy capacity; when it does not, the rule-level default applies. The flow has no opinion about how big any part should be — it only respects the bound it is handed. This keeps the balance lever where design decisions live (the recipe and the rule), and it makes "a part that holds no energy at all" a legitimate design (an explicit zero) rather than a special case the flow has to detect.

## 7. Why the flow rides the round-start hook — and its exact order

The flow must see what the IC per-turn step did *in the same round*. The coal generator organ charges its battery at the start of the round (the IC step runs first), and the flow runs after it — so the turn-start picture it redistributes already includes that round's fresh charge. Ordering it after the IC step is what makes "charge, then circulate" true within a single round instead of lagging a round behind. It is a passive step on the round-start hook, not a route or an action: circulation happens whether or not anyone is watching, at the world's cadence.

## 8. Why the rule is a single off-switch with total degradation

The `energyFlow` entry in `data/world_rules.json` is the entire switch for the feature. Missing key, malformed key, missing file, or an explicit off — any of them leaves the flow fully off: one warning at boot, zero per-turn log noise, and the world boots and runs exactly as if the feature did not exist. The flow step simply does nothing when the rule is off, so turning the rule on or off is a data decision, not a code decision, and a broken data file degrades the feature instead of crashing the world. This mirrors the graceful-degradation contract the other world rules already follow, and it is deliberate: a balance law must be removable by editing one file.

## 9. Why a balanced network is silent

A network that has converged — every part holding the same amount — is a fixed point: nothing has changed. Without a guard, floating-point rounding would make the step compute a microscopic "change" and write it anyway, which would mean the droid writes and broadcasts a full world state every single round for the rest of its life, for no observable reason. The flow therefore treats changes smaller than a named, deliberately tiny threshold as no changes at all. A balanced droid produces zero writes and zero broadcasts; the network only speaks when something actually moved.

## 10. Why exactly one broadcast per flow turn

Full-state broadcasts are the expensive, high-noise channel to the clients. The flow wraps its step in a scoped broadcast window that follows the same discipline the facade already uses for other batched phases: if the step changed anything, exactly one consolidated full-state broadcast goes out; if it changed nothing, none does. The flow never broadcasts per component and never more than once per turn, so a droid at steady state is invisible on the wire and a droid in flux costs at most one state update per turn.

## 11. Why the change surface is deliberately minimal

The flow adds no snapshot fields — energy is already part of the persisted component stat set, so save/restore round-trips unchanged at the existing schema version. It adds no actions, no routes, no client code, and no gameplay effect: the stat it circulates is the same stat the fuel loop charges and the client already draws. The entire feature is one per-turn step, one rule key, one suppressed-damage write path, and one broadcast scope — which is exactly the size a world law should be.

## See also

- [Internal Components](../data/internal_components.md) — the fuel loop that charges the pool the flow circulates
- [World Rules](../data/world_rules.md) — the layer that owns the `energyFlow` switch
- [Material Damage & Chunk Drop](../data/material_damage_and_drop.md) — the damage pipeline the flow's writes are kept out of
- [World State](../data/world_state.md) — the persisted stat set the flow reuses without extension
