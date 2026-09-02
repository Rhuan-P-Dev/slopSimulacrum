# BUG-132: Channel Damage Silently Never Applied (DAMAGE_CHANNELS Member Test on an Object)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `a5b49ef` (the commit that introduced both the per-material damage-type split and the chunk drop — the one-line guard fix that closed this bug, `DAMAGE_CHANNELS.includes` → `Object.values(DAMAGE_CHANNELS).includes`, shipped in that same commit)
- **Related Files**: `src/controllers/consequences/DamageConsequenceHandler.js`

## Symptoms

Channel-based damage — the `damageComponent` consequence that carries a `channel` (punch, cut, shootT1) — appeared to deal nothing: targets did not lose the expected existence, yet the action itself "succeeded." The failure was silent end to end. No error reached the player or the logs, because the consequence dispatcher's try/catch swallowed the underlying `TypeError` that was thrown on **every** channel-damage call. The entire channel-damage path was non-functional, but it looked like a no-op rather than a crash.

## Root Cause

The per-channel loss step validated its incoming channel with an "is this one of the damage channels?" membership test against `DAMAGE_CHANNELS`. The defect is a type mismatch in that guard: `DAMAGE_CHANNELS` is **not** a list of channel names — it is a constant-name → channel-name **object** (a map). Running an array-style membership test against that object never matched any real channel, so the guard rejected every one of them. Each rejected channel produced a zero loss, and the mismatched access raised a `TypeError` that the dispatcher's try/catch absorbed without surfacing. The net effect was that channel damage was computed as zero and the exception was hidden — a total feature outage dressed up as "nothing happened."

## Fix

The membership test now runs against the object's **values** (the actual channel names) instead of treating the object as an array. It is a one-line correction that restores the documented intended behavior: every declared channel is recognized, and each is converted to a channel-aware existence loss against the target's own resistance to that channel, summed into one delta. This fix is what makes the per-material damage-type split (Feature 1) and the chunk drop (Feature 2) reachable in the first place.

## Prevention

- **Match the guard to the constant's shape.** Before writing a membership check, confirm whether the symbol is a *list* of names or a *named map*. A test written for one shape silently misbehaves on the other — and a `TypeError` raised inside a guarded region is the tell.
- **Do not let a dispatcher try/catch turn a broken feature into a silent no-op.** An unexpected exception inside a consequence handler is a signal that a code path is broken, not a recoverable runtime hiccup. Swallowing it (rather than logging it at a level that is visible in a normal run) is exactly what kept this bug hidden. Surfacing or loudly logging unexpected exceptions in consequence handlers is the class of change that would have caught this the first time it ran.
- **A feature that "never fires" is a testable claim.** The new contract tests assert that channel damage actually changes existence for each in-scope action, which is precisely the assertion that was missing and that would have caught a zero-loss path.

## References

- Feature spec: [`wiki/material_damage_and_drop_spec.md`](../../material_damage_and_drop_spec.md) (§D3)
- Related wiki: [`wiki/subMDs/data/material_damage_and_drop.md`](../../subMDs/data/material_damage_and_drop.md)
- Related tests: [`test/contract/materialDamageSplit.contract.test.js`](../../../test/contract/materialDamageSplit.contract.test.js), [`test/unit/materialDamageTypes.test.js`](../../../test/unit/materialDamageTypes.test.js)
- Related controller: `DamageConsequenceHandler`
