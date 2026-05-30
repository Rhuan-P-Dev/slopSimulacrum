# BUG-092: Equipped Item Component ID `equipped-undefined-knife` Causes Entity Not Found Error

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `WorldStateController.js`, `componentCapabilityController.js`, `HoldingCostController.js`, `actionController.js`, `actionSelectController.js`, `ComponentResolver.js`

## Symptoms

When equipping a knife and executing the `cut` action, the component ID showed `equipped-undefined-knife` instead of `equipped-{valid-id}-knife`. The action appeared to execute successfully but then failed with "Entity not found" because the malformed component ID could not be resolved to a valid equipped item.

## Root Cause

Two interconnected bugs in the equipped item system:

### Bug 1: itemId Loss in WorldStateController

`WorldStateController.getAllEquippedItems()` used `Object.entries()` destructuring with `[, item]`, which drops the object key. Since `itemId` was the object key (not a property), `item.itemId` was `undefined`. This caused all equipped items to have `itemId: undefined` when passed to downstream systems, producing the malformed component ID `equipped-undefined-knife`.

### Bug 2: No Validation at Any Layer

There was no validation at any layer to reject malformed component IDs. `HoldingCostController.equipItem()` didn't validate `itemId`, `actionController.js` didn't reject IDs containing `undefined`, `actionSelectController.validateSelections()` didn't filter malformed IDs, and `ComponentResolver.resolveSourceComponent()` didn't check for malformed IDs. The bugs compounded: the bad data flowed through every layer unchecked.

## Fix

A five-layer defense was implemented:

1. **WorldStateController.js** — Fixed `itemId` extraction from `Object.entries` key. Changed `[, item]` to `[itemId, item]` to capture the key as the `itemId` variable.
2. **componentCapabilityController.js** — Added skip for equipped items with invalid or empty `itemId`.
3. **componentCapabilityController.js** — Used actual `equipped.componentId` as primary, falling back to synthetic ID.
4. **HoldingCostController.js** — Added `itemId` validation on equip with clear error message.
5. **HoldingCostController.js** — Filtered invalid keys in `getAllEquippedItems()` before returning.
6. **actionController.js** — Rejected malformed equipped component IDs containing `undefined` or `null`.
7. **actionController.js** — Added fallback to match by `eq.componentId` directly when parsing synthetic ID fails.
8. **actionSelectController.js** — Filtered malformed IDs in batch validation.
9. **actionSelectController.js** — Rejected malformed IDs in `validateSelection`.
10. **ComponentResolver.js** — Filtered malformed entries in `buildComponentList`.
11. **ComponentResolver.js** — Rejected malformed IDs in `resolveSourceComponent`.

## Prevention

1. **Input validation at every boundary** — All layers that process component IDs must validate against `undefined`/`null` string placeholders
2. **Equip validation** — `HoldingCostController.equipItem()` must validate `itemId` before processing
3. **Capability scanning** — `ComponentCapabilityController._scanEquippedItemsForActions()` must skip items with invalid `itemId`
4. **Use real componentId** — Equipped item entries should prefer `equipped.componentId` over synthetic `equipped-${itemId}-${itemType}` IDs

## References

- Related wiki: `wiki/subMDs/controllers/capability_controller.md`
- Related controller: `ComponentCapabilityController`, `HoldingCostController`, `ActionController`, `ActionSelectController`, `ComponentResolver`