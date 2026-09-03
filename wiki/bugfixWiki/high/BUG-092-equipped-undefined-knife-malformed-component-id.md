# BUG-092: Equipped Item Component ID `equipped-undefined-knife` Causes Entity Not Found Error

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
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

A multi-layer defense was added so malformed equipped IDs can no longer propagate:

- `WorldStateController` now captures the item id from the equipped-items map key, so downstream systems receive a real `itemId` instead of `undefined`.
- Every boundary that processes equipped component ids — equip, capability scanning, action validation/selection, and component resolution — now validates against `undefined`/`null` placeholders and filters or rejects malformed ids.
- Capability entries prefer the item's real `componentId` over the synthetic `equipped-${itemId}-${itemType}` format.

Rationale: the root failure was that one layer produced bad data and every subsequent layer trusted it unchecked; the fix makes each boundary reject what it cannot validate.

## Prevention

1. **Input validation at every boundary** — All layers that process component IDs must validate against `undefined`/`null` string placeholders
2. **Equip validation** — `HoldingCostController.equipItem()` must validate `itemId` before processing
3. **Capability scanning** — `ComponentCapabilityController._scanEquippedItemsForActions()` must skip items with invalid `itemId`
4. **Use real componentId** — Equipped item entries should prefer `equipped.componentId` over synthetic `equipped-${itemId}-${itemType}` IDs

## References

- Related wiki: `wiki/subMDs/controllers/capability_controller.md`
- Related controller: `ComponentCapabilityController`, `HoldingCostController`, `ActionController`, `ActionSelectController`, `ComponentResolver`