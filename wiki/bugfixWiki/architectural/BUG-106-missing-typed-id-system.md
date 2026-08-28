# BUG-106: Missing Typed ID System — Component/Item/Equipped IDs Not Self-Describing

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/utils/idGenerator.js`, `src/utils/IdResolver.js`, `src/controllers/core/entityController.js`, `src/controllers/core/stateEntityController.js`, `src/utils/InventoryManager.js`, `src/controllers/core/HoldingCostController.js`, `src/controllers/core/EquippedItemStatsController.js`, `src/controllers/actions/ComponentResolver.js`, `src/controllers/actions/actionController.js`, `src/controllers/actions/actionSelectController.js`

## Symptoms

- Component IDs, item IDs, and equipped item IDs were indistinguishable from each other
- Server had to guess whether an incoming ID was a component, item, or equipped item
- Equipped items used synthetic IDs (`equipped-${itemId}-${itemType}`) that were inconsistent
- Malformed equipped IDs (e.g., `equipped-undefined-knife`) caused runtime errors
- No way to validate ID type without attempting multiple lookup strategies

## Root Cause

The original design used three incompatible ID schemes:
- Raw UUIDs for entities and components (no type prefix)
- Sequential numbers for inventory items (`item-1`, `item-2`)
- Synthetic strings for equipped items (`equipped-${itemId}-${itemType}`)

No type information was embedded in the IDs themselves. The server had to use fallback logic to determine what kind of object an ID referred to.

## Fix

Implemented a typed ID system where every ID is prefixed with its type, so the kind of object an ID refers to is self-evident from the ID itself and the server no longer needs to guess or fall back through multiple lookup strategies. The `IdResolver` utility parses any typed ID and determines its type and UUID in O(1) time via prefix matching, and all controllers now validate incoming IDs before processing.

## Prevention

All future ID generation must use the typed generators from `idGenerator.js`. New entity/item types must add their own prefix to `IdResolver.js` and a corresponding generator function.

## References

- Related wiki: `wiki/subMDs/systems/unique_id_system.md`
- Related controllers: `ComponentResolver`, `ActionController`, `HoldingCostController`, `EquippedItemStatsController`
- Related pattern: Single Source of Truth (from `wiki/project_rules.md`)