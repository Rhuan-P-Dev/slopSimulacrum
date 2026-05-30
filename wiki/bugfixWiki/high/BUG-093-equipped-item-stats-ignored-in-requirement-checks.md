# BUG-093: Equipped Item Stats Ignored in Action Requirement Checks

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/actions/RequirementResolver.js`

## Symptoms

When equipping the knife (which has `Physical.sharpness: 50`) and attempting to cut an enemy, the player received a "No component possesses the required Physical.sharpness (>= 20)" warning. Even though the knife definition clearly defined `Physical.sharpness: 50`, the requirement check failed.

## Root Cause

A two-part mismatch between how the frontend sent component IDs and how the server resolved them.

### Part 1: Capability Controller Used Host Component ID

The `ComponentCapabilityController._scanEquippedItemsForActions()` created capability entries with the host component ID (e.g., `droidHand-xyz`), not an "equipped-" prefixed ID. This meant the "cut" action appeared in the UI as available, but the component ID pointed to the host component, not the equipped item.

### Part 2: RequirementResolver Only Handled Prefixed IDs

`RequirementResolver.checkComponentRequirements()` only handled `equipped-` prefixed IDs. Since the capability controller sent host component IDs (e.g., `droidHand-xyz`), the resolver fell into the else branch and only checked the host component's stats — which had no sharpness trait.

The fallback parsing in `_resolveEquippedItemTraits()` tried to parse `equipped-<itemId>-<itemType>` from the componentId, but since the componentId was `droidHand-xyz` (no "equipped-" prefix), the fallback was never triggered.

**Why this matters**: The capability controller and requirement resolver used inconsistent component ID formats. One used host IDs, the other expected prefixed IDs. This disconnect meant equipped items were invisible to requirement validation.

## Fix

Added `_resolveEquippedTraitsForHostComponent(componentId, entityId)` private method to `RequirementResolver` that:

1. Calls `worldStateController.getAllEquippedItems()` to get all equipped items across entities
2. Matches `eq.componentId === componentId` to find if this host component has an equipped item
3. Looks up the item definition from `worldStateController.getItemRegistry()` by `equipped.itemType`
4. Returns the item's traits directly as a shallow-copied stats object

Both `checkComponentRequirements()` and `resolveRequirementValues()` now check for equipped items on the host component **before** falling back to the component's own stats.

## Prevention

- The capability controller and requirement resolver must use **consistent component ID formats** — if capability entries use host component IDs, requirement checks must also handle host component IDs
- When adding new item types with traits, ensure both capability scanning AND requirement execution paths resolve the same traits
- The "equipped-" prefix check alone is insufficient — there must always be a fallback that checks if a host component has an equipped item

## References

- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related controller: `RequirementResolver`, `ComponentCapabilityController`, `HoldingCostController`
- Related data: `data/inventoryItems.json`, `data/actions.json`