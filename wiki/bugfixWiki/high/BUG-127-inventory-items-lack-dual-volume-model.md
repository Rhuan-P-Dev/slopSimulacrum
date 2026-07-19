# BUG-127: Inventory Items Lack Dual-Volume Model (externalVolume Not Supported)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `t1-weapon-implementation`
- **Related Files**: [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js), [`data/inventoryItems.json`](data/inventoryItems.json)

## Symptoms

Items with separate external footprint and internal capacity (such as the T1 weapon) could not be properly represented. All items used a single `volume` property to serve both the host component space allocation and the container capacity, causing incorrect spatial calculations when an item's physical size differed from its internal storage.

## Root Cause

The `InventoryManager` only used `itemDef.volume` for host component space calculation, with no concept of `externalVolume`. This meant that items designed to occupy a small footprint on a host component but have larger internal capacity could not be modeled. The dual-purpose use of a single `volume` property created an inherent limitation in the inventory system's volume model.

## Fix

Added `externalVolume` support to `addItem()`, `moveItem()`, `getComponentVolume()`, and `_calculateComponentUsedVolume()` in `InventoryManager.js`. Items now use `hostVolume` (derived from `externalVolume` or `volume` as fallback) for host component space allocation, while `volume` is used for container capacity calculations. This separation allows items like the T1 weapon to define both their physical footprint (`externalVolume: 1`) and their internal capacity (`volume: 10`) independently.

## Prevention

When designing new item types with dual-volume needs, always define both `volume` (internal capacity) and `externalVolume` (host footprint) in the item definition. The `externalVolume` property takes precedence when present; if absent, `volume` is used as the fallback for both purposes.

## References

- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related wiki: `wiki/subMDs/data/components_and_entities.md`
- Related controller: `InventoryManager` (server-side)
