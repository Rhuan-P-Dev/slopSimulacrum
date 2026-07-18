# BUG-120: _isDescendantOf Potential Infinite Loop on Corrupted Data

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: Current implementation (visited Set added)
- **Related Files**: [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js) (lines 444-461)

## Symptoms

The `_isDescendantOf()` method walks up the parent chain via `current.hostComponentId`. If a circular reference exists in the data (item A has hostComponentId = B, item B has hostComponentId = A), the method would loop infinitely, blocking all container operations and freezing both server and client.

## Root Cause

The method used a simple `while (current)` loop without any visited tracking or depth limit:

```javascript
// Before (vulnerable):
_isDescendantOf(itemId, ancestorId) {
    let current = this._items[itemId];
    while (current) {
        if (current.hostComponentId === ancestorId) return true;
        current = this._items[current.hostComponentId];
    }
    return false;
}
```

## Fix

Added a `visited` Set to track visited `hostComponentId` values. If a circular reference is detected, the method returns `false` instead of looping:

```javascript
// After (protected):
_isDescendantOf(itemId, ancestorId) {
    const visited = new Set();
    let current = this._items[itemId];
    while (current) {
        if (visited.has(current.hostComponentId)) return false;
        visited.add(current.hostComponentId);
        if (current.hostComponentId === ancestorId) return true;
        current = this._items[current.hostComponentId];
    }
    return false;
}
```

## Prevention

Data validation should be added to detect and reject circular references during container operations (e.g., in `moveItem` and `addItem`). This prevents corrupted state from ever forming.

## References

- Related wiki: `wiki/nested_inventory_design.md`
- Related controller: `InventoryManager`
