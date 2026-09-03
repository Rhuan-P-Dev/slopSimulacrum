# BUG-134: Two-Fist Punch Drops No Chunks (D11 No-Propagation Blocked Intended Per-Fist Drops)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `src/controllers/consequences/ConsequenceDispatcher.js`, `src/controllers/consequences/MaterialChunkDropHandler.js`, `src/controllers/consequences/DamageConsequenceHandler.js`, `test/contract/doublePunchChannelDamage.contract.test.js`

## Symptoms

A droid punching with **both** fists selected dealt its full synergy-scaled damage to the target (that part had been restored by BUG-133), but left nothing behind: no chunk of the target's material ever appeared on the ground, while the very same punch from a single fist regularly dropped chunks. Fighing with two fists — the stronger attack — produced a strictly worse salvage experience than the weaker one. There was no log hint and no error: the drop step did run, once per fist, and each time it quietly converted nothing.

## Root Cause

Two deliberate designs met at the drop step and cancelled the feature's intent. The chunk-drop handler consumes exactly one input — the applied loss that the damage step publishes into the dispatch context — and the multi-attacker path deliberately keeps full parameter propagation off, because its per-attacker consequences run in isolated contexts that must never merge one attacker's output into another's. With propagation off, the loss each fist's own damage step published stayed trapped in that fist's isolated context and never reached that same fist's own drop step — so every per-fist drop saw "no loss" and did nothing. The spec had codified that as an intentional "multi-attacker never drops" rule (D11), but the rule conflated two different things: the legitimate no-*aggregation* principle (never form one number out of two attackers' outputs) and the accidental consequence that even a *per-attacker* publication — one that never crosses attacker boundaries — was blocked. The no-aggregation principle is correct and was never what caused the silence; what was blocked was a publication that stays local to each attacker.

## Fix

The publication rule on the multi-attacker path was refined from "propagate nothing" to "propagate exactly one reserved key, and only inside each attacker's own isolated context": the dispatcher now carries forward the reserved applied-loss key that the damage handler writes, and nothing else. Because every attacker is still dispatched into a fresh isolated context, a fist's published loss is visible only to that fist's own later consequences — so two fists perform two independent roll-and-drop passes, each computed from its own applied loss and its own attacking material, with the existing per-material probability, per-material volume share, and global minimum-volume rules applying to each roll separately. The drop handler itself needed no behavior change: it already resolves each attacker's material from the per-attacker context and already consumes only the published loss. Every other handler-modified param keeps the path's no-propagation semantics, so the damage math, the synergy scaling, and the formula-exact loss numbers are untouched, and the feature-off degradation (empty drop-rates file → no chunks, no crash) still applies per roll.

## Prevention

- The two-fist contract test now covers the full per-fist drop behavior with deterministic rolls: an always-drop material taken from the data file, a forced per-roll outcome sequence proving that one fist's success is independent of the other fist's failure, formula-exact per-fist volumes that differ between the two fists (and differ from what a combined loss would have produced), and the empty-data-file degradation case; together with the unchanged single-attacker contract test, the two pin both sides of the publish→drop contract.
- The spec (D11) and the two related sub-wikis now state the refined rule — per-attacker publication is not aggregation — so a future reader of "the multi-attacker path never propagates" cannot re-derive the old no-drop conclusion.
- The dispatcher documents the one-key exception next to the no-propagation rule, so any future per-attacker need (for example a per-attacker event log) extends the reserved-key mechanism instead of re-enabling full propagation.

## References

- Related wiki: `wiki/subMDs/data/material_damage_and_drop.md`
- Related wiki: `wiki/subMDs/controllers/consequence_handler_architecture.md`
- Related wiki: `wiki/material_damage_and_drop_spec.md` (D5, D11)
- Related controller: `ConsequenceDispatcher`
- Related bug: [BUG-133](BUG-133-multi-attacker-punch-drops-channel-damage.md) — the multi-attacker damage fix this one completes
