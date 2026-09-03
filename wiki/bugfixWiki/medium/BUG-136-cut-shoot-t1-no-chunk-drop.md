# BUG-136: `cut` and `shootT1` Drop No Material Chunks

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `data/actions.json` (cut / shootT1 consequence lists), `data/materialDropRates.json`, `test/contract/materialChunkDropCutShootT1.contract.test.js`, `wiki/material_damage_and_drop_spec.md` (D6)

## Symptoms

Performing `cut` (equipped knife) or `shootT1` (T1 with ammunition) on a component dealt its channel damage normally, but **never** left a material chunk on the ground — while `droid punch` did. Player report (received in Portuguese, glossed here): "the T1's cut and shoot actions are not dropping chunks". The feature looked broken for two of its three in-scope actions, even though the drop pipeline itself worked.

## Root Cause

Chunk drop is a **data-declared consequence**, not an implicit effect of dealing damage: the drop pipeline (damage step publishes the applied channel loss → dispatcher propagates it → the drop handler rolls per-material drops) is fully wired and **action-name-agnostic** — it runs for any action whose consequence list declares the drop consequence. The consequence was declared only on `droid punch`. The initial release deliberately scoped chunk drop to punch only (spec D6: "which actions drop chunks is a data decision"), so `cut` and `shootT1` — whose consequence lists contain only their damage step and bookkeeping steps — legitimately never entered the drop path. This was therefore a missing data declaration (the scoping decision), not a pipeline defect: no code path was wrong, the declaration was simply absent for two of the three channel-damage actions.

## Fix

Data-only, no code changes: the drop consequence was added to the two missing consequence lists in `data/actions.json`, positioned **after** each action's damage consequence (the drop step consumes the loss the damage step published, so the declaration must follow the damage step in the list) and before the remaining bookkeeping steps:

- `cut`: after `damageComponent`, before `updateComponentStatDelta` (the sharpness drain).
- `shootT1`: after `consumeItemAndDamage`, before `log`.

The `_comment` in `data/materialDropRates.json` was reworded from "per successful punch" to "per successful channel-damage hit", since drops now apply to punch, cut, and shootT1. The wiki scope wording (spec D6 and integration table, sub-wiki, map, CORE) was generalized accordingly. Balance behavior is intentionally unchanged: `shootT1`'s applied loss is tiny (the projectile's volume), so its chunks usually sit at the `minChunkVolume` floor — correct D7 behavior, not something to "fix".

## Prevention

- Consequence lists in data are the single declaration surface for "what happens when an action succeeds". When a consequence-driven feature is scoped to a subset of actions, the scope lives in data (which actions declare the consequence) — expanding or shrinking that scope must be done in the data files, and the spec's scope notes must be updated in the same change.
- A **data-level regression guard** now asserts that each channel-damage action's consequence list declares the drop consequence *after* its damage consequence, so silently dropping the declaration from any action is caught by the test suite.
- Behavior-level contract tests prove `cut` and `shootT1` actually shed chunks through the full action pipeline (volume derived from the same data files the server reads).

## References

- Related wiki: `wiki/subMDs/data/material_damage_and_drop.md`, `wiki/material_damage_and_drop_spec.md` (D6 — the drop is a data-declared consequence; D7 — volume contract)
- Related controllers: `MaterialChunkDropHandler`, `DamageConsequenceHandler`, `ConsequenceDispatcher`
- Regression tests: `test/contract/materialChunkDropCutShootT1.contract.test.js`
