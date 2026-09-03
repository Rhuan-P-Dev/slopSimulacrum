# BUG-097: Cut Action Shows "0 capables · 1 incapable" After Use

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `src/controllers/WorldStateController.js`, `src/controllers/capabilities/componentCapabilityController.js`

## Symptoms

After equipping a knife and successfully executing the "cut" action against an enemy, the "Actions" panel shows "cut — 0 capables · 1 incapable".

The cut action disappears from the available actions even though the knife is still equipped with `Physical.sharpness: 50`.

## Root Cause

### The Chain of Events

1. Executing the `cut` action drained the equipped knife's sharpness, firing the stat-change callback.
2. The callback had to find which entity owns the item in order to re-evaluate that entity's capabilities.
3. **Bug**: The entity lookup compared the item id against the wrong key, and `WorldStateController.getAllEquippedItems()` returned a flattened array **without** the `eqId` field, so the owning entity could not be reliably identified.

### Why The Capability Cache Became Stale

When the entity lookup fails, the capability re-evaluation never fires, so the cache keeps showing "can execute" based on the old sharpness value while the knife actually has less.

### The Fix

The stat-change callback now identifies the owning entity by direct key lookup against the nested equipped-items structure (entity → equipped items) instead of iterating entries and comparing ids, and the flattened `getAllEquippedItems()` result includes the `eqId` field so all callers see consistent identifiers. A stat change therefore always triggers capability re-evaluation for the correct entity.

## Prevention

1. **Always use direct key lookup** when you have a known key — `items[eqId]` is O(1) and correct, while `Object.entries(items).find()` is O(n) and error-prone.
2. **Flattened data must include all identifiers** — any method that flattens a nested structure should include keys at every level.
3. **Stat change callbacks must always trigger re-evaluation** — if a callback is registered for stat changes, verify it correctly identifies the affected entity.

## References

- Related wiki: `wiki/subMDs/systems/sharpness_system.md`
- Related controller: `ComponentCapabilityController`, `EquippedItemStatsController`, `WorldStateController`
- Related bug: [BUG-099](high/BUG-099-cut-action-damage-ignores-sharpness-drain.md) — sharpness drain wiring