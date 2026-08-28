# BUG-120: _isDescendantOf Potential Infinite Loop on Corrupted Data

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: Current implementation (visited Set added)
- **Related Files**: [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js) (lines 444-461)

## Symptoms

The `_isDescendantOf()` method walks up the parent chain via `current.hostComponentId`. If a circular reference exists in the data (item A has hostComponentId = B, item B has hostComponentId = A), the method would loop infinitely, blocking all container operations and freezing both server and client.

## Root Cause

The method walked `hostComponentId` up the parent chain in a simple `while (current)` loop with no visited tracking or depth limit, so a circular host reference would never terminate.

## Fix

The walk now tracks visited `hostComponentId` values in a `Set`; when a cycle is detected it returns `false` immediately instead of looping forever.

## Prevention

Data validation should be added to detect and reject circular references during container operations (e.g., in `moveItem` and `addItem`). This prevents corrupted state from ever forming.

## References

- Related wiki: `wiki/nested_inventory_design.md`
- Related controller: `InventoryManager`
