# 🔢 Typed ID System Adoption Status

This document tracks the adoption of the typed ID system (`ent-`, `comp-`, `item-`, `eq-`) across all system areas.

## Overview

The typed ID system provides self-describing identifiers that encode type information in the prefix:
- `ent-${uuid}` — Entity IDs
- `comp-${uuid}` — Component IDs
- `item-${uuid}` — Inventory Item IDs
- `eq-${uuid}` — Equipped Item IDs

## Adoption Status (Full Migration)

| Area | Status | Details |
|------|--------|---------|
| ID Generation (`utils/idGenerator.js`) | ✅ Complete | All generators use `crypto.randomUUID()` |
| ID Resolution (`utils/IdResolver.js`) | ✅ Complete | `isEntityId`, `isCompId`, `isItemId`, `isEquippedId`, `parseId`, `wrapId`, `unwrapId` |
| Browser-compatible IdResolver (`public/utils/IdResolver.js`) | ✅ Complete | Pure JavaScript, no Node.js dependencies |
| ComponentCapabilityController | ✅ Complete | Replaced synthetic `equipped-${uuid}-${type}` with typed `eq-${uuid}` IDs; added `_eqId` and `_entityId` fields |
| WorldStateController (server) | ✅ Complete | Added `getEquippedItem(entityId, eqId)`, `getEquippedItemByItemId(entityId, itemId)`, `getEquippedItemForComponent(entityId, compId)` |
| WorldStateManager (client) | ✅ Complete | Added `getEquippedItem(entityId, eqId)` |
| Route files | ✅ Complete | IdResolver import + typed ID validation in all route files |
| WorldStateBroadcastService | ✅ Complete | Added `_transformForBroadcast()` — all IDs are typed before broadcast |
| Frontend files | ✅ Complete | All legacy `startsWith('equipped-')` replaced with `IdResolver.isEquippedId()` |
| **Legacy Compatibility** | ❌ **Removed** | No backward compatibility — system uses ONLY typed IDs |

## Typed ID Format Reference

| ID Type | Prefix | Generator Function | Example |
|---------|--------|-------------------|---------|
| Entity ID | `ent-` | `generateEntityId()` | `ent-550e8400-e29b-...` |
| Component ID | `comp-` | `generateCompId()` | `comp-6ba7b810-9dad-...` |
| Inventory Item ID | `item-` | `generateItemId()` | `item-6ba7b811-9dad-...` |
| Equipped Item ID | `eq-` | `generateEquippedId()` | `eq-6ba7b812-9dad-...` |
| Room ID | _none_ | `generateUID()` | `550e8400-e29b-...` |

## Changes Made

### ComponentCapabilityController (Server)
- **Replaced** synthetic `equipped-${itemId}-${itemType}` with typed `eq-${uuid}` IDs
- Added `_eqId` field to ALL equipped item capability entries
- Added `_entityId` field to ALL capability entries (host + equipped)
- Added `eqId: \`eq-\${generateEquippedId()}\`` to equipped items

### WorldStateController (Server)
- Added `import IdResolver from '../utils/IdResolver.js'`
- Added `getEquippedItem(entityId, eqId)` — lookup by typed eqId
- Added `getEquippedItemByItemId(entityId, itemId)` — lookup by itemId
- Added `getEquippedItemForComponent(entityId, componentId)` — lookup by component
- Added `_validateEquippedId(eqId)` — validates `eq-` prefix

### WorldStateManager (Client)
- Added `getEquippedItem(entityId, eqId)` — lookup equipped item by typed eqId

### Route Files
- Added `import IdResolver from '../utils/IdResolver.js'` to all route files
- Added typed ID validation helpers (`validateEntityId`, `validateCompId`, `validateItemId`)
- Applied to: `actionRoutes.js`, `selectionRoutes.js`, `inventoryRoutes.js`, `capabilityRoutes.js`

### WorldStateBroadcastService
- Added `import { generateItemId, generateEquippedId } from '../utils/idGenerator.js'`
- Added `_transformForBroadcast(state)` method that ensures all IDs are typed before broadcast

### Frontend: App.js
- Added `import { IdResolver } from './utils/IdResolver.js'`
- Replaced `componentId.startsWith('equipped-')` → `IdResolver.isEquippedId(componentId)` in `_setupActionCallback()` and `_buildNavActionsData()`
- Replaced legacy `_handleEquippedItemClick` parsing: componentId is now directly `eq-${uuid}`, no substring/split parsing needed
- Uses `this.worldState.getEquippedItem(entityId, eqId)` to look up itemId and itemType

### Frontend: NavActionsPanel.js
- Added `import { IdResolver } from './utils/IdResolver.js'`
- Replaced `componentId.startsWith('equipped-')` → `IdResolver.isEquippedId(componentId)` in `_buildActionSection()`

### Frontend: InventoryManager.js
- Changed `_equippedItems` keying from `eq.itemId` to `eq.id` (typed eqId)
- Added `_isEquippedByItemId(itemId)` — searches by itemId for legacy item references
- Added `_findEquippedByItemId(itemId)` — returns equipped item object by itemId
- Updated all `_equippedItems` lookups to use eqId keys with itemId helper methods

## Legacy Removed

- ❌ No backward compatibility for raw UUIDs
- ❌ No `startsWith('equipped-')` legacy parsing
- ❌ No synthetic `equipped-${uuid}-${type}` ID format
- ✅ System uses ONLY typed IDs (`ent-`, `comp-`, `item-`, `eq-`)

## Client-Server Typed ID Flow

```
Server:
  ComponentCapabilityController → eqId: eq-${uuid}
  WorldStateBroadcastService → _transformForBroadcast() → all IDs typed
  ↓ (WebSocket broadcast)
Client:
  WorldStateManager → state.entities[ent-uuid].equipped[] → { id: "eq-uuid", ... }
  App.js → IdResolver.isEquippedId(eqId) → getEquippedItem(entityId, eqId)
  NavActionsPanel → IdResolver.isEquippedId(entry.componentId)
  InventoryManager → _equippedItems[eqId] = eq (keyed by eqId)
```

## References

- Related wiki: `wiki/subMDs/systems/unique_id_system.md`
- Related controller: `IdResolver`, `idGenerator`
- Related bug: `wiki/bugfixWiki/architectural/BUG-106-missing-typed-id-system.md`
- Related bug: `wiki/bugfixWiki/architectural/BUG-107-typed-id-system-partial-adoption.md`
