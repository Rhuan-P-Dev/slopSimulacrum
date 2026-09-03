# BUG-133: Multi-Attacker Punch Drops Channel Damage (Zero Damage Dealt)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `src/controllers/consequences/ConsequenceDispatcher.js` (`_buildPerAttackerConsequences`)

## Symptoms

A droid punching with **both** of its fists selected as sources dealt **no damage at all** to the target, even though the same punch from a single fist worked perfectly and its log message still printed. The failure was silent end to end: the action reported success, the punch message fired, yet the target's existence never moved. Because a two-fist punch is the only combat path that routes through the multi-attacker consequence builder, the bug could not be seen by testing the ordinary single-fist punch at all.

## Root Cause

The multi-attacker path rebuilds each consequence's declared parameters from scratch before dispatching them, and that rebuild was written for the **legacy stat-delta model** — a damage value expressed as a signed delta against a single trait/stat pair. Two independent defects, each sufficient on its own to zero a modern **channel-damage** punch, lived in that rebuild:

1. **The damage axis was dropped.** A channel-damage consequence names its target axis by a channel rather than by a trait/stat pair. The rebuild forced every damage value into the legacy trait/stat shape, so the channel fell out with nothing to replace it — leaving the handler unable to tell *what kind* of loss to apply.
2. **The value was sign-flipped.** Even where a channel survived, the rebuild emitted the attacker's strength as a *negative* number, following the legacy additive-delta convention. The channel-loss step only ever counts a positive amount (a raw value divided by a per-channel resistance, clamped at zero), so a negative input collapsed to zero damage.

Either defect alone was enough to produce zero damage; both had to be fixed together.

## Fix

The per-attacker builder now reads each consequence's **declared** parameters and branches on the model the data actually uses, instead of forcing everything into the legacy shape:

- **Channel model:** the declared channel is passed straight through (never hardcoded), and the declared value is resolved **per attacker** with the same placeholder mechanism the single-attacker path already uses — so a punch that scales on strength deals strength, and a cut that scales on sharpness deals sharpness. The resolved value is a positive raw amount, exactly what the channel-loss step expects.
- **Legacy model:** a consequence that declares a trait/stat pair is left untouched — still an additive signed delta, as before.

At the time of this fix the path's no-propagation rule meant the chunk-drop step had nothing to convert, so the two-fist punch dealt full damage but dropped no chunks — documented then as the consistent reading of spec D11. That no-drop behavior turned out to be a defect of its own (a two-fist punch should drop *more* salvage, not less) and was completed in [BUG-134](BUG-134-two-fist-punch-drops-no-chunks.md): the publication rule was refined so each attacker's own loss is carried forward inside that attacker's isolated context only.

## Prevention

- A **unit** test pins the builder's contract for both models: the channel is preserved, the value resolves to the attacker's declared stat (not unconditionally to strength), and the legacy trait/stat form keeps its signed-delta shape. A dedicated case covers a channel action whose value is a **non-strength** stat — the exact shape the old rebuild would have silently mis-scaled.
- A **contract** test drives a real two-fist punch through the whole pipeline and asserts formula-exact synergy-scaled loss, the per-attacker result shape, and — with real, non-vacuous checks — the per-fist drop behavior that D11 now specifies: one chunk per successful roll, volume derived from that fist's own loss, forced per-roll independence, and a clean feature-off degradation (D11, revised; see BUG-134).
- Two related gaps are known and intentionally left for separate work (neither blocks this fix): the punch's **log message** still prints its raw strength placeholder, because log text is stored outside the consequence's parameters and is not placeholder-resolved on this path; and the punch's **synergy configuration** declares a damage-cap requirement key that no code currently reads.

## References

- Related wiki: `wiki/subMDs/controllers/consequence_handler_architecture.md`
- Related wiki: `wiki/subMDs/data/material_damage_and_drop.md`
- Related controller: `ConsequenceDispatcher`
- Related bug: [BUG-132](BUG-132-channel-damage-silently-never-applied.md) — the single-attacker channel-damage outage this builds on
