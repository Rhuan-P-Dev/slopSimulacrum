# BUG-094: Cut Action Disappears After Unequip/Re-equip (Sharpness Resets)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/core/HoldingCostController.js` (line 313 removed)

## Symptoms

When a knife is equipped and used for the `cut` action, its sharpness stat drains (e.g., -999 per use). Once sharpness drops below the required minimum (20), the `cut` action correctly becomes unavailable. However, if the player unequips the knife and re-equips it, the sharpness stat resets to its original value (e.g., 1000), making the `cut` action available again — which is incorrect behavior. The stat should remain depleted.

## Root Cause

`HoldingCostController.unequipItem()` called `this.equippedItemStats.removeStats(itemId)`, which completely deleted the item's mutable stats from the in-memory `_itemStats` map. On re-equip, `EquippedItemStatsController.initializeStats()` creates a fresh copy from `data/inventoryItems.json`, restoring all stats to their base values.

`EquippedItemStatsController.initializeStats()` already had a guard that preserves existing stats, but the guard was never reached: `removeStats()` deleted the stats on unequip, so re-equip always treated the item as brand-new and re-initialized every stat to its base value.

## Fix

Removed the `removeStats()` call from the unequip path so mutable stats persist across equip/unequip cycles. On re-equip, the existing `initializeStats()` guard detects the pre-existing stats and preserves them. Rationale: wear accumulated during use (e.g., sharpness drain) is a property of the item instance, so the unequip path must not destroy it — otherwise action availability would keep resetting in lockstep with equip/unequip cycles.

## Prevention

When modifying unequip/cleanup logic, verify that mutable item stats (sharpness, durability) are not destroyed. The `EquippedItemStatsController` owns mutable item state and its `initializeStats()` guard is designed to preserve existing stats — do not call `removeStats()` unless the item is being permanently destroyed.

## References
- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related controller: `EquippedItemStatsController`
- Related controller: `HoldingCostController`