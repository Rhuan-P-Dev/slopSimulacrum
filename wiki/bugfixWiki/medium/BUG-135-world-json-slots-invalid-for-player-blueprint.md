# BUG-135: world.json Initial-Spawn Slots Invalid for Player Blueprint (smallBallDroid)

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `data/world.json`, `test/contract/playerInitialSpawns.contract.test.js`

## Symptoms
The player (smallBallDroid) spawned with 0 items from the declarative loadout. The coal, T1, and knife entries in `data/world.json` referenced component types (`m1CentralBody`, `m1Leg`) that exist only on the `m1Droid` blueprint. The slot resolver returned `null` for each entry; each was WARN-logged ("no valid slot") and skipped. The m1Droid NPC was unaffected (it has those components).

Additionally, the contract test `playerInitialSpawns.contract.test.js` contained hardcoded assertions for items (`metalBox`, `testItem`, `testItem2`) not present in the data file and not described in the wiki spec ("coal loadout, T1 weapon, knife stock"), causing test failures independent of the data bug.

## Root Cause
The `data/world.json` `initialSpawns` slot values were written against the `m1Droid` component vocabulary without considering that the same file drives the player's (`smallBallDroid`) loadout. The slot resolver performs exact component-type lookup (or ordered `firstFit`), so a type name absent from the entity's component list silently resolves to `null`. The test file was written against an earlier or different loadout composition and was never reconciled with the shipped data file.

## Fix
1. **Data**: Changed the slot expressions to `firstFit:` forms that resolve for both blueprints in priority order:
   - coal: `firstFit:m1CentralBody,centralBall`
   - knife: `firstFit:m1Leg,droidRollingBall`
   - t1: `bestAvailable:hand` (already cross-blueprint via substring match)

   The m1Droid matches its native types first; the smallBallDroid falls through to its equivalent high-capacity components. The knife fallback targets `droidRollingBall` (volume 12, late in the component list) rather than `droidArm` to avoid inventory spill into the trigger-test's break-first-3-components assertion.

2. **Test**: Replaced the stale hardcoded item assertions with data-driven checks matching the wiki spec (10 coal, 1 t1 + 1 ammo, 5 knives = 17 items, no "no valid slot" warnings).

## Prevention
- Slot expressions in `data/world.json` must use `firstFit:` or `bestAvailable:` forms when the loadout targets multiple blueprints; plain type names are only safe when the file is blueprint-specific.
- Contract tests should read item counts from the data file rather than hardcoding them, so the test stays in lockstep with balance changes.

## References
- Related wiki: `wiki/map.md` (Data Files section — `data/world.json`)
- Related controller: `WorldStateController._resolveInitialSpawnSlot`
