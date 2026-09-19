# BUG-121: components.json Repeatedly Loaded on Every Volume Check

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: Current implementation (cached in constructor)
- **RelatedFiles**: [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js) (lines 20-25, 66-78, 318-336)

## Symptoms

Every inventory operation (adding or moving an item) triggered redundant re-reads of `data/components.json`, causing unnecessary I/O overhead on every inventory operation.

## Root Cause

The component definitions were not cached at the InventoryManager level: the volume-check methods (`_getComponentMaxVolume()`, `_getComponentMaxVolumeFromEntity()`) loaded `data/components.json` fresh on every invocation, even though the file is static data that rarely changes.

## Fix

The component definitions are now loaded once in the constructor and held as a class-level cache. The volume-check methods read from that cache instead of re-reading the file, eliminating per-operation I/O on static data.

## Prevention

Stateless utility methods that need repeated data access should cache data at the class level. Static configuration files should be loaded once and reused throughout the application lifecycle.

## References

- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related controller: `InventoryManager`
