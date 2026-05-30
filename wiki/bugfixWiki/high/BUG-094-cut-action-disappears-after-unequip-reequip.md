# BUG-094: Cut Action Disappears After Unequip/Re-equip (Sharpness Resets)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/core/HoldingCostController.js` (line 313 removed)

## Symptoms

When a knife is equipped and used for the `cut` action, its sharpness stat drains (e.g., -999 per use). Once sharpness drops below the required minimum (20), the `cut` action correctly becomes unavailable. However, if the player unequips the knife and re-equips it, the sharpness stat resets to its original value (e.g., 1000), making the `cut` action available again — which is incorrect behavior. The stat should remain depleted.

## Root Cause

`HoldingCostController.unequipItem()` called `this.equippedItemStats.removeStats(itemId)`, which completely deleted the item's mutable stats from the in-memory `_itemStats` map. On re-equip, `EquippedItemStatsController.initializeStats()` creates a fresh copy from `data/inventoryItems.json`, restoring all stats to their base values.

**Flow:**
```
1. Equip knife → initializeStats() creates sharpness = 1000
2. Use "cut" → sharpness drains by -999 → sharpness = 1
3. sharpness < 20 → "cut" unavailable ✅
4. Unequip → removeStats() DELETES all in-memory stats ❌
5. Re-equip → initializeStats() creates FRESH sharpness = 1000 ❌
6. sharpness >= 20 → "cut" available again ❌ (BUG!)
```

`EquippedItemStatsController.initializeStats()` already has a guard that preserves existing stats:
```javascript
if (this._itemStats[itemId]) {
    return { success: true, message: `Stats already initialized for item "${itemId}".` };
}
```

But this guard was never reached because `removeStats()` deleted the stats before re-equip could trigger the guard.

## Fix

Removed the `this.equippedItemStats.removeStats(itemId)` call from `HoldingCostController.unequipItem()`. The mutable stats now persist across equip/unequip cycles. On re-equip, `initializeStats()`'s existing guard detects the pre-existing stats and preserves them.

**Behavior after fix:**
```
1. Equip knife → initializeStats() creates sharpness = 1000
2. Use "cut" → sharpness = 1
3. "cut" unavailable (sharpness < 20) ✅
4. Unequip → stats preserved in memory ✅
5. Re-equip → initializeStats() sees existing stats, preserves them ✅
6. sharpness still = 1 → "cut" still unavailable ✅ (CORRECT!)
```

## Prevention

When modifying unequip/cleanup logic, verify that mutable item stats (sharpness, durability) are not destroyed. The `EquippedItemStatsController` owns mutable item state and its `initializeStats()` guard is designed to preserve existing stats — do not call `removeStats()` unless the item is being permanently destroyed.

## References
- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related controller: `EquippedItemStatsController`
- Related controller: `HoldingCostController`