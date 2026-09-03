# BUG-075: Missing Holding Cost System — Items Cannot Impose Stat Requirements on Equipment

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
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

The `/inventory/holding-cost-registry` endpoint was registered **after** the parameterized `GET /inventory/:entityId` route in Express. Express matches routes in registration order, so requests to `/inventory/holding-cost-registry` were intercepted by `/:entityId` with `entityId = "holding-cost-registry"`, causing the server to log `WARN: [WorldStateController] Entity "holding-cost-registry" not found for inventory query.` and respond with a 500 error.

The client silently failed to load the holding cost registry, resulting in an empty `_holdingCostRegistry` object. Without it, the equip button condition `this._holdingCostRegistry[item.type]` was always falsy.

**Fix**: Moved all static routes before parameterized routes in `inventoryRoutes.js` and added architectural comment explaining the ordering requirement.

### Tertiary: Equipped Items Not Scanned for Actions

The capability controller (`ComponentCapabilityController`) only scanned entity components against action requirements. It never checked equipped items. This meant that even when a knife was equipped (with `Physical.sharpness: 50` in `data/inventoryItems.json`), the `cut` action (requiring `Physical.sharpness >= 20`) was never discovered as available.

## Fix

### 1. Holding cost system (controller + data + API + UI)

A server-side `HoldingCostController` now owns equip/unequip/transfer: it validates minimum stats before equipping, applies the holding-cost debuffs to the host component, and clears them on unequip. Why: equipment must impose physical demands (stat requirements plus debuffs), not just consume volume, and equip state must be server-owned so a client cannot fake it. Definitions live in `data/holdingCost.json` so new stat-requiring items are data changes, not code changes (data-driven design standard). The client shows equip/unequip buttons and a visual indicator distinguishing actions provided by an equipped item.

### 2. Equipped Item Action Discovery

The capability controller now scans equipped items in addition to entity components during capability (re)evaluation. Why: an equipped item *is* a stat source, so excluding it from the scan made the actions it enables (e.g., `cut` for a sharp knife) invisible; scanning on every re-evaluation is what makes actions appear and disappear on equip/unequip.

### 3. Fixed Express route ordering: static routes BEFORE parameterized routes

A parameterized route matches any path segment, so registering it before a static path silently intercepts that path. The ordering requirement is now a documented standard (see Prevention).

### 4. Public access to equipped items

`WorldStateController` exposes a public getter for all equipped items so the capability controller obtains them through the controller API instead of reaching into private state (single-source-of-truth standard).

## Prevention

- Always consider stat requirements when adding new item types
- Add holding cost entries to `data/holdingCost.json` for items that should require stats to equip
- Use `HoldingCostController.equipItem()` for all equip operations
- Provide public getter methods on controllers instead of accessing private properties from parent controllers
- **Express Route Rule**: Always register static routes BEFORE parameterized routes in the same router file. Parameterized routes (`/:id`) match any path segment and will intercept static paths if registered first.
- **Equipped Item Rule**: All equipped items are automatically scanned for action capabilities during capability re-evaluation. Adding traits to `data/inventoryItems.json` is sufficient to enable item actions.
- Add defensive logging in client-side data loading to surface server-side issues

## Bug Fix: Auto-Unequip Equipped Item on Drag-and-Drop

### Symptom
When dragging an equipped item (e.g., a knife) to another component, the item was physically moved but the equip tracking was NOT updated. The item remained tracked as equipped on the OLD component while physically residing on a NEW component. This caused:
- Debuffs remaining on the old component after the item was moved
- Capability actions still appearing as available from the wrong component
- Inconsistent server/client state

### Root Cause
`InventoryManager._onDrop()` only called `_autoUnequipOnTarget()` which checked for equipped items on the **target** component. It did not check if the **dragged item itself** was equipped.

### Fix
The drop handler now auto-unequips the **dragged** item (server-side, which removes its debuffs) whenever it is equipped, before handling the target component. Why: equip state is tied to the item's physical host — moving an equipped item changes that host, so every drop involving an equipped item must trigger the server-side unequip or the debuffs and capability entries stay anchored to the wrong component.

### Prevention
- Whenever drag-and-drop moves items, always check if the dragged item is equipped
- Update client-side tracking immediately on successful server unequip

## Secondary Bug Fix: Unequip Re-applying Debuff

### Symptom
After equipping an item (knife), clicking "Unequip" would show "Item unequipped successfully" but the debuffs remained on the component. Clicking "Equip" again would re-apply debuffs on top of existing ones.

### Root Cause (2 bugs)

**Bug A — Premature `_cleanupTracking` in failure paths:**
`HoldingCostController.unequipItem()` called `_cleanupTracking(entityId, itemId)` BEFORE returning `success: false` when the holding cost definition or original stats were missing. This removed tracking data while leaving debuffs active on the component permanently.

**Bug B — Stale data in client-side re-render:**
After equip/unequip, `_onEquipClick` and `_onUnequipClick` only called `_loadEquippedItems()` but NOT `_loadEntityItems()`. The `_renderInventory()` method used stale `_currentItems` data. When combined with the world state broadcast potentially arriving at a different time, the UI could render with inconsistent state.

### Fix
1. Tracking cleanup now happens only on a **successful** unequip. Why: cleaning up tracking on a failed unequip orphans the debuffs — the record that says where they came from is gone, so nothing can remove them.
2. After equip/unequip, the client reloads both the entity's items and the equipped-item state before re-rendering, so the panel never renders from a stale mix of the two data sets.

### Third Bug: `data-is-equipped` Attribute Always `false` — THE ACTUAL UNEQUIP BUG

#### Symptom
Clicking "🔓 Unequip" fires the equip handler instead — server log shows `Equipped knife` 3 times with ZERO `Unequipped` calls.

#### Root Cause
In `_renderItems()`, the `data-is-equipped` attribute was set from the raw equipped-state value (an object), which stringifies to `"[object Object]"` rather than `"true"`. The event-listener check compared the attribute against the literal string `'true'`, so it was **always `false`**, and every button wired to the equip handler regardless of actual equip status.

#### Fix
The attribute is now set to an explicit `'true'`/`'false'` string, so the listener's string comparison reflects the actual equip state.

## References
- Related wiki: `wiki/subMDs/data/holding_cost.md`
- Related controller: `HoldingCostController`
- Related method: `ComponentCapabilityController._scanEquippedItemsForActions()`
- Related method: `InventoryManager._autoUnequipDraggedItem()`
