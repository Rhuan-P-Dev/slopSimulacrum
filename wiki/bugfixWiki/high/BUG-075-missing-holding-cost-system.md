# BUG-075: Missing Holding Cost System — Items Cannot Impose Stat Requirements on Equipment

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/core/HoldingCostController.js`, `data/holdingCost.json`, `src/controllers/WorldStateController.js`, `src/controllers/capabilities/componentCapabilityController.js`, `src/routes/inventoryRoutes.js`, `public/js/InventoryManager.js`, `public/js/NavActionsPanel.js`, `public/css/inventory.css`, `public/css/actions.css`

## Symptoms

No way to equip items with stat requirements. Items in the inventory always count toward volume, but there's no mechanism to:
1. Require minimum stats to equip an item
2. Apply debuffs when an item is held
3. Transfer holding costs between components (hand swap)
4. Equip button does not appear on items with holding costs
5. Equipped items (like knives) do not show their actions (like "cut") in the action panel

## Root Cause

### Primary: Missing Holding Cost Controller

The inventory system only handled volume-based storage. There was no holding cost controller to enforce stat requirements or apply stat debuffs.

### Secondary (Critical): Express Route Ordering Bug — THE ACTUAL BUG CAUSING THE MISSING BUTTON

The `/inventory/holding-cost-registry` endpoint was registered **after** the parameterized `GET /inventory/:entityId` route in Express. Express matches routes in registration order, so requests to `/inventory/holding-cost-registry` were intercepted by `/:entityId` with `entityId = "holding-cost-registry"`, causing a 500 error:

```
WARN: [WorldStateController] Entity "holding-cost-registry" not found for inventory query.
```

The client silently failed to load the holding cost registry, resulting in an empty `_holdingCostRegistry` object. Without it, the equip button condition `this._holdingCostRegistry[item.type]` was always falsy.

**Fix**: Moved all static routes before parameterized routes in `inventoryRoutes.js` and added architectural comment explaining the ordering requirement.

### Tertiary: Equipped Items Not Scanned for Actions

The capability controller (`ComponentCapabilityController`) only scanned entity components against action requirements. It never checked equipped items. This meant that even when a knife was equipped (with `Physical.sharpness: 50` in `data/inventoryItems.json`), the `cut` action (requiring `Physical.sharpness >= 20`) was never discovered as available.

## Fix

### 1. Created `HoldingCostController` with equip/unequip/transfer logic

### 2. Data-driven holding cost definitions in `data/holdingCost.json`

### 3. Server API endpoints for equip/unequip/transfer operations

### 4. Client UI with equip/unequip buttons (CSS + JS)

### 5. Integration with capability system for action discovery

### 6. Equipped Item Action Discovery — The NEW FIX

Added equipped item scanning to `ComponentCapabilityController`:

- **`_scanEquippedItemsForActions(state)`** — New private method that scans equipped items across all entities, converts their traits from `data/inventoryItems.json` to stats-like objects, and checks them against all action requirements. If an equipped item satisfies an action's requirements, a capability entry is added with `_isEquippedItem: true` metadata.

- **`_convertTraitsToStats(traits)`** — Helper method that converts item traits to a stats-like format compatible with the existing scoring system.

- **`_checkEquippedItemRequirements(requirements, itemStats, equipped)`** — Helper that checks if equipped item traits satisfy all action requirements.

- **`scanAllCapabilities()`** — Now calls `_scanEquippedItemsForActions()` after scanning entity components.

- **`reEvaluateEntityCapabilities()`** — Now calls `_scanEquippedItemsForActions()` after re-scanning entity components, so equipped items appear/disappear from the action list on equip/unequip.

### 7. WorldStateController public API additions

- **`getAllEquippedItems()`** — Returns all equipped items across all entities as a flat array with `entityId` enrichment. Used by the capability controller.

### 8. UI: Equipped Item Indicator in Action Panel

`NavActionsPanel._buildActionSection()` detects equipped item entries (componentId starts with `"equipped-"`) and adds:
- 🔪 knife icon before the item name
- `nav-equipped-item` CSS class for orange left border
- `data-equipped-type` attribute for CSS targeting

### 9. Fixed Express route ordering: static routes BEFORE parameterized routes

### 10. Added defensive logging and error toasts in client-side `InventoryManager`

## Prevention

- Always consider stat requirements when adding new item types
- Add holding cost entries to `data/holdingCost.json` for items that should require stats to equip
- Use `HoldingCostController.equipItem()` for all equip operations
- Provide public getter methods on controllers instead of accessing private properties from parent controllers
- **Express Route Rule**: Always register static routes BEFORE parameterized routes in the same router file. Parameterized routes (`/:id`) match any path segment and will intercept static paths if registered first.
- **Equipped Item Rule**: All equipped items are automatically scanned for action capabilities during capability re-evaluation. Adding traits to `data/inventoryItems.json` is sufficient to enable item actions.
- Add defensive logging in client-side data loading to surface server-side issues

## Secondary Bug Fix: Unequip Re-applying Debuff

### Symptom
After equipping an item (knife), clicking "Unequip" would show "Item unequipped successfully" but the debuffs remained on the component. Clicking "Equip" again would re-apply debuffs on top of existing ones.

### Root Cause (2 bugs)

**Bug A — Premature `_cleanupTracking` in failure paths:**
`HoldingCostController.unequipItem()` called `_cleanupTracking(entityId, itemId)` BEFORE returning `success: false` when the holding cost definition or original stats were missing. This removed tracking data while leaving debuffs active on the component permanently.

**Bug B — Stale data in client-side re-render:**
After equip/unequip, `_onEquipClick` and `_onUnequipClick` only called `_loadEquippedItems()` but NOT `_loadEntityItems()`. The `_renderInventory()` method used stale `_currentItems` data. When combined with the world state broadcast potentially arriving at a different time, the UI could render with inconsistent state.

### Fix
1. Removed premature `_cleanupTracking` calls from error paths in `HoldingCostController.unequipItem()` — tracking is only cleaned up on **successful** unequip
2. Changed `_onEquipClick` and `_onUnequipClick` to reload both `_loadEntityItems` and `_loadEquippedItems` in parallel via `Promise.all()` before re-rendering

### Third Bug: `data-is-equipped` Attribute Always `false` — THE ACTUAL UNEQUIP BUG

#### Symptom
Clicking "🔓 Unequip" fires the equip handler instead — server log shows `Equipped knife` 3 times with ZERO `Unequipped` calls.

#### Root Cause
In `_renderItems()`, the `data-is-equipped` attribute was set to the raw object value:
```javascript
data-is-equipped="${isEquipped}"   // isEquipped = { itemId, itemType, componentId }
```
When coerced to string, this becomes `"[object Object]"` not `"true"`. The event listener check `btn.dataset.isEquipped === 'true'` was therefore **always `false`**, so all equip buttons wired to `_onEquipClick` regardless of actual equip status.

#### Fix
Changed to explicit ternary: `data-is-equipped="${isEquipped ? 'true' : 'false'}"`

## References
- Related wiki: `wiki/subMDs/data/holding_cost.md`
- Related controller: `HoldingCostController`
- Related method: `ComponentCapabilityController._scanEquippedItemsForActions()`