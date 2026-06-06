# BUG-108: Synthetic equipped ID format (`equipped-${uuid}-${type}`) replaced with typed `eq-${uuid}` IDs

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `typed-id-full-migration`
- **Related Files**: `src/controllers/capabilities/componentCapabilityController.js`, `src/controllers/WorldStateController.js`, `public/js/App.js`, `public/js/NavActionsPanel.js`, `public/js/InventoryManager.js`, `public/js/WorldStateManager.js`, `src/services/WorldStateBroadcastService.js`

## Symptoms

Equipped item IDs used a synthetic concatenation format `equipped-${itemId}-${itemType}` (e.g., `equipped-item-uuid-knife`) instead of the typed ID system's `eq-${uuid}` format. This violated the typed ID system's consistency and required legacy string parsing on the client side using `componentId.startsWith('equipped-')` and manual `substring()`/`lastIndexOf()` parsing to extract the itemId and itemType.

## Root Cause

The typed ID system was partially adopted (BUG-106, BUG-107), but equipped item IDs were not migrated. The ComponentCapabilityController generated equipped IDs using the synthetic `equipped-` prefix pattern, which was incompatible with the `IdResolver` system and required custom parsing logic across multiple client files.

## Fix

### Server-side (ComponentCapabilityController)
- Added `import { generateEquippedId } from '../../utils/idGenerator.js'`
- Added `_eqId: \`eq-\${generateEquippedId()}\`` to ALL equipped item capability entries
- Added `_entityId` field to ALL capability entries
- Removed synthetic `equipped-${itemId}-${itemType}` format

### Server-side (WorldStateController)
- Added `import IdResolver from '../utils/IdResolver.js'`
- Added `getEquippedItem(entityId, eqId)` — lookup by typed eqId
- Added `getEquippedItemByItemId(entityId, itemId)` — lookup by itemId
- Added `getEquippedItemForComponent(entityId, componentId)` — lookup by component
- Added `_validateEquippedId(eqId)` — validates `eq-` prefix

### Server-side (WorldStateBroadcastService)
- Added `_transformForBroadcast(state)` — ensures all IDs are typed before broadcast

### Client-side (App.js)
- Added `import { IdResolver } from './utils/IdResolver.js'`
- Replaced `componentId.startsWith('equipped-')` → `IdResolver.isEquippedId(componentId)`
- Removed legacy parsing in `_handleEquippedItemClick`: componentId is now directly `eq-${uuid}`
- Uses `this.worldState.getEquippedItem(entityId, eqId)` to look up itemId and itemType

### Client-side (NavActionsPanel.js)
- Added `import { IdResolver } from './utils/IdResolver.js'`
- Replaced `componentId.startsWith('equipped-')` → `IdResolver.isEquippedId(componentId)`

### Client-side (InventoryManager.js)
- Changed `_equippedItems` keying from `eq.itemId` to `eq.id` (typed eqId)
- Added `_isEquippedByItemId(itemId)` and `_findEquippedByItemId(itemId)` helper methods

### Client-side (WorldStateManager.js)
- Added `getEquippedItem(entityId, eqId)` — lookup equipped item by typed eqId

### Browser-compatible IdResolver
- Created `public/utils/IdResolver.js` — pure JavaScript, no Node.js dependencies

### Legacy Compatibility
- **Removed entirely** — no backward compatibility for raw UUIDs or `equipped-` prefix

## Prevention

1. All ID generation must use the typed ID generators (`generateEntityId`, `generateCompId`, `generateItemId`, `generateEquippedId`)
2. Client-side ID type checks must use `IdResolver` methods, not string prefix checks
3. All IDs in state broadcasts must pass through `_transformForBroadcast()`
4. No synthetic ID formats (like `equipped-${uuid}-${type}`) are permitted

## References
- Related wiki: `wiki/subMDs/systems/typed_id_adoption.md`
- Related bug: `wiki/bugfixWiki/architectural/BUG-106-missing-typed-id-system.md`
- Related bug: `wiki/bugfixWiki/architectural/BUG-107-typed-id-system-partial-adoption.md`