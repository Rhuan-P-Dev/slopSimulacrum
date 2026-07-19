# BUG-129: Client-Side Inventory Uses item.volume Instead of externalVolume for Host Component Display

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `t1-weapon-implementation`
- **Related Files**: [`public/js/InventoryManager.js`](public/js/InventoryManager.js) (lines ~415, ~477-478, ~1082, ~1097, ~1435)

## Symptoms

1. T1 weapon displayed as taking 10 volume on host component instead of 1.
2. Component volume bars showed 10/10 (100%) for T1 instead of 1/10 (10%).
3. T1 container was not visible as an expandable storage area in the client UI.
4. Items could not be dragged into T1's internal inventory from the client.

## Root Cause

The client-side [`InventoryManager.js`](public/js/InventoryManager.js) used `item.volume` for all volume calculations and display. For items with dual-volume (external footprint vs internal capacity), this caused:

- **Host component space calculation**: Used `item.volume` (internal capacity, 10 for T1) instead of `item.externalVolume` (external footprint, 1 for T1), resulting in the component volume bar showing 100% usage for an item that physically occupies only 10% of the component.
- **Container rendering logic**: The condition for showing a container header required items to already be inside the container. Empty containers with available capacity were not rendered because `_getUsedVolume()` returned `item.volume` (10) rather than `item.externalVolume` (1), making the system believe the container was full.
- **Drag-and-drop fit check**: `_checkItemFit()` used `item.volume` for the child item's space requirement, causing drag-and-drop to fail for items that would actually fit when using the correct volume metric.

## Fix

1. Modified volume calculations to use `item.externalVolume ?? item.hostVolume ?? item.volume` for host component space. Applied in `_getUsedVolume()` (line ~415), `_calculateComponentUsedVolume()` (lines ~477-478), and related methods (lines ~1082, ~1097, ~1435).
2. Added container rendering for items with `volume >= 5` (indicating internal capacity), even when empty, so the expandable container UI appears before any items are placed inside.
3. Updated drag-and-drop fit checks in `_checkItemFit()` to use `item.externalVolume ?? item.volume` for child items.
4. Added container UI elements: expand/collapse header and "Drag items here" hint text for empty containers.

## Prevention

When adding new items with `externalVolume` property, ensure all client-side volume calculations distinguish between:
- **Host footprint**: Use `item.externalVolume ?? item.hostVolume ?? item.volume` for space taken on a parent component.
- **Container capacity**: Use `item.volume` for internal storage capacity.

Always verify that dual-volume items render correctly on the client, especially empty containers that should still display their expandable UI.

## References

- Related wiki: `wiki/subMDs/systems/t1_weapon_system.md`
- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related bug: `wiki/bugfixWiki/high/BUG-127-inventory-items-lack-dual-volume-model.md`
- Related bug: `wiki/bugfixWiki/high/BUG-128-t1-weapon-placement-used-wrong-volume-metric.md`
- Related controller: `InventoryManager` (client-side)
