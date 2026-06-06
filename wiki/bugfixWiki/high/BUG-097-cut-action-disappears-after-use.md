# BUG-097: Cut Action Shows "0 capables · 1 incapable" After Use

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/WorldStateController.js`, `src/controllers/capabilities/componentCapabilityController.js`

## Symptoms

After equipping a knife and successfully executing the "cut" action against an enemy, the "Actions" panel shows for cut:

```
cut
0 capables · 1 incapable
```

The cut action disappears from the available actions even though the knife is still equipped with `Physical.sharpness: 50`.

## Root Cause

### The Chain of Events

1. User executes cut action — sharpness drains from equipped knife
2. `EquippedItemStatsController._notifyStatChange` fires the callback registered in `WorldStateController`
3. The callback iterated over `HoldingCostController.getAllEquippedItems()` to find which entity owns the item
4. **Bug**: The iteration used `Object.entries(items)` with `id === itemId` comparison, where `id` was the loop variable from `Object.entries(items)`. But the comparison parameter was `itemId` (the callback's first argument from `EquippedItemStatsController`), which was the **eqId**.
5. The comparison worked because `Object.entries(items)[0][0]` returns the eqId, matching the callback parameter. **However**, the bug was that `WorldStateController.getAllEquippedItems()` returned a flattened array **without** the `eqId` field, so any code relying on that flattened array for eqId lookup would fail.

### Why The Capability Cache Became Stale

When sharpness drains:
1. The stat change callback triggers `reEvaluateEntityCapabilities` for the entity
2. This correctly re-scans capabilities with current stats
3. But if the callback's entity lookup fails (wrong iteration), the re-evaluation never fires
4. The stale cache persists — showing "can execute" based on old sharpness (50) while the knife actually has less

### The Fix

**a.** Fixed `WorldStateController` stat change callback to iterate `HoldingCostController.getAllEquippedItems()` using direct key lookup (`items[eqId]`) instead of `Object.entries(items)`:

```javascript
equippedItemStats.setStatChangeCallback((eqId, traitId, statName, newValue, oldValue) => {
    const allEquipped = this.holdingCostController.getAllEquippedItems();
    for (const [entityId, items] of Object.entries(allEquipped)) {
        if (items[eqId]) {  // Direct key lookup — O(1) instead of O(n) iteration
            // Entity found — re-evaluate its capabilities
            const state = this.getAll();
            this.actionController.reEvaluateEntityCapabilities(state, entityId);
            if (this._broadcastService) {
                this._broadcastService.broadcast();
            }
            return;
        }
    }
});
```

**b.** Fixed `WorldStateController.getAllEquippedItems()` to include `eqId` in all returned objects, ensuring consistency across all callers:

```javascript
getAllEquippedItems() {
    // ...
    for (const [entityId, items] of Object.entries(allEquipped)) {
        for (const [eqId, item] of Object.entries(items)) {
            allItems.push({
                entityId,
                eqId,  // ← Added: eqId was missing before
                itemId: item.itemId,
                itemType: item.itemType,
                componentId: item.componentId
            });
        }
    }
    return allItems;
}
```

## Prevention

1. **Always use direct key lookup** when you have a known key — `items[eqId]` is O(1) and correct, while `Object.entries(items).find()` is O(n) and error-prone.
2. **Flattened data must include all identifiers** — any method that flattens a nested structure should include keys at every level.
3. **Stat change callbacks must always trigger re-evaluation** — if a callback is registered for stat changes, verify it correctly identifies the affected entity.

## References

- Related wiki: `wiki/subMDs/systems/sharpness_system.md`
- Related controller: `ComponentCapabilityController`, `EquippedItemStatsController`, `WorldStateController`
- Related bug: [BUG-099](high/BUG-099-cut-action-damage-ignores-sharpness-drain.md) — sharpness drain wiring