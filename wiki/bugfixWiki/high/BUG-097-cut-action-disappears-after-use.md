# BUG-097: Cut Action Shows "0 capables · 1 incapable" After Use

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/capabilities/componentCapabilityController.js`, `src/controllers/consequences/StatConsequenceHandler.js`

## Symptoms

After equipping a knife and successfully executing the "cut" action against an enemy, the "Actions" panel shows for cut:

```
cut
0 capables · 1 incapable
```

The cut action disappears from the available actions even though the knife is still equipped with `Physical.sharpness: 50`.

## Root Cause

### The Chain of Events

1. User executes cut action — `attackerComponentId` is the host component ID
2. The `updateComponentStatDelta` consequence fires, draining 1 sharpness from the host component (not the knife)
3. A stat change event fires on the host component
4. `ComponentCapabilityController.onStatChange()` → `reEvaluateActionForComponent()` checks **host component stats**, which don't have `Physical.sharpness`
5. The score becomes 0, and the cut entry is removed from the capability cache
6. Client refreshes — entity is still in cache (other actions remain), so `scanAllCapabilities()` is not called, and the cut entry stays gone

### Why This Happens

The `ComponentCapabilityController.onStatChange()` → `reEvaluateActionForComponent()` pipeline checked only **host component stats** when it should have checked **equipped item traits**. This is the same bug pattern that BUG-093 fixed in `RequirementResolver`, but in a different code path.

BUG-093 addressed **requirement checking during action execution**. BUG-097 addresses **capability cache maintenance after stat changes**. They are related but distinct code paths — fixing one without the other leaves the other broken.

### Additional Problem: Cache Not Rebuilt

After the entry is incorrectly removed, `getActionsForEntity()` only calls `scanAllCapabilities()` if the cache is empty or the entity is not in cache. Since the entity still has other action entries (move, dash), the cache rebuild is skipped, and the cut entry stays gone permanently.

### The Fix

Added three new private methods to `ComponentCapabilityController`:

1. **`_getEquippedTraitsForHostComponent(componentId)`** — Finds if a host component has an equipped item and returns the item's traits directly
2. **`_getEffectiveStatsForAction(componentId, actionData)`** — Used by `reEvaluateActionForComponent()` — prefers equipped item traits if they satisfy the action requirements
3. **`_getEffectiveStatsForComponent(componentId)`** — Used by `_checkRequirementsForComponent()` — prefers equipped item traits when available

Modified `reEvaluateActionForComponent()` to use `_getEffectiveStatsForAction()` instead of `getComponentStats()`, and `_checkRequirementsForComponent()` to use `_getEffectiveStatsForComponent()`. This ensures consistency: capability scoring, requirement checking, and cache re-evaluation all use the same trait resolution logic.

## Prevention

- **All capability scoring paths must use consistent trait resolution** — any method that checks component stats for action requirements must also check for equipped items
- **Stat change handlers should not remove capability entries for equipped item actions** — the re-evaluation logic must account for equipped item traits
- **When fixing a requirement check path, review all other paths that use component stats for action-related scoring**

## References

- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related controller: `ComponentCapabilityController`, `StatConsequenceHandler`
- Related bug: `BUG-093-equipped-item-stats-ignored-in-requirement-checks.md`
- Related data: `data/inventoryItems.json`, `data/actions.json`