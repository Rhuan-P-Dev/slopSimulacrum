# BUG-133: Multi-Attacker Punch Drops Channel Damage (Zero Damage Dealt)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/consequences/ConsequenceDispatcher.js` (lines 493–518)

## Symptoms

A droid with two `droidHand` fists performing a "droid punch" with both fists selected as `source` dealt **zero damage** to the target. The single-fist punch (the normal `execute()` path) worked correctly, so the bug only manifested in the multi-attacker case. The punch action's log message fired, but no existence loss was applied.

## Root Cause

The two-fist case is the **only** combat path routed through the multi-attacker consequence builder (`executeMultiAttacker` → `_buildPerAttackerConsequences`). That builder was written for the **legacy stat-delta model** and contains two independent defects that each zero the channel damage:

1. **Channel field dropped**: For `damageComponent` consequences, the builder rebuilds params as `{ trait, stat, value: -strength }`. The punch action declares `{ channel: "impact", value: ":Physical.strength" }` — it has no `trait`/`stat` fields — so `channel` is silently dropped from the rebuilt params.

2. **Negative value**: Even with `channel` preserved, the value is negated (`-strength`). The channel-loss formula (`channelLossFromResistance`) clamps with `Math.max(0, value)`, so a negative raw value becomes zero loss.

Both defects independently produce zero damage; fixing only one is insufficient.

## Fix

`_buildPerAttackerConsequences` now inspects the declared params of each `damageComponent` consequence:

- **Channel model** (`params.channel` present): emits `{ channel, value: +strength }` — the channel string is preserved and the value is **positive** (matching the channel-loss formula's contract). The per-attacker material split is resolved downstream from `context.attackerComponentId`.
- **Legacy model** (no channel, declares `trait`/`stat`): unchanged — emits the additive negative delta `{ trait, stat, value: -strength }`.

The `propagateParams: false` constraint on the multi-attacker path (spec D11) is preserved: the drop-material-chunk consequence remains a no-op because the published channel loss is never carried forward, consistent with that path's semantics.

## Prevention

- The unit test `test/unit/ConsequenceDispatcher.buildPerAttackerConsequences.test.js` asserts the correct shape for both channel and legacy models.
- The contract test `test/contract/doublePunchChannelDamage.contract.test.js` exercises the full round-trip with two fists, verifying formula-exact synergy-scaled loss, per-attacker result shape, and the D11 no-chunks behavior.

## Follow-ups (Known Out-of-Scope)

- **Log placeholder**: the punch log message `Droid performed a punch dealing :Physical.strength impact damage!` prints the raw `:Physical.strength` placeholder because the `log` consequence stores `message`/`level` at the top level (not inside `params`), and neither `_resolveParams` nor the log branch in `_buildPerAttackerConsequences` resolves top-level placeholders. Cosmetic only.
- **Dead synergy cap key**: the punch synergy config in `data/synergy.json` declares `caps.damage.req: "Physical.strength"`, but no code reads this key. Cosmetic; do not modify as part of this fix.

## References

- Related wiki: `wiki/subMDs/controllers/consequence_handler_architecture.md`
- Related wiki: `wiki/subMDs/data/material_damage_and_drop.md`
- Related controller: `ConsequenceDispatcher`
- Related wiki: `wiki/bugfixWiki/high/BUG-132-channel-damage-silently-never-applied.md`
