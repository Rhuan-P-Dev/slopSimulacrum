# BUG-124: _checkItemFit Does Not Account for Container Volume

- **Severity**: MEDIUM
- **Status**: 🔴 Open
- **Fixed In**: —
- **Related Files**: [`public/js/InventoryManager.js`](public/js/InventoryManager.js) (lines 1064-1091)

## Symptoms

The `_checkItemFit()` method only checks component-level volume (`_currentItems[targetCompId]`). It does not account for items that might be inside containers on that component. This means drag-and-drop on a component could allow placing an item that would exceed the component's volume if container items are also present.

## Root Cause

The client-side volume check was not updated when nested inventory was added. The server-side `InventoryManager` tracks container item volumes, but the client-side `_checkItemFit()` only considers direct component items.

## Fix

Update `_checkItemFit()` to also check container item volumes when the target component has container items:

```javascript
// Before (incomplete):
_checkItemFit(targetCompId, itemVolume) {
    const currentItems = this._currentItems[targetCompId] || 0;
    const maxVolume = this._getComponentMaxVolume(targetCompId);
    return (currentItems + itemVolume) <= maxVolume;
}

// After (complete):
_checkItemFit(targetCompId, itemVolume) {
    let currentItems = this._currentItems[targetCompId] || 0;

    // Add container item volumes if any containers exist on this component
    const containerIds = this._getContainerIdsForComponent(targetCompId);
    for (const containerId of containerIds) {
        const containerItems = this._getContainerItemVolumes(containerId);
        currentItems += containerItems;
    }

    const maxVolume = this._getComponentMaxVolume(targetCompId);
    return (currentItems + itemVolume) <= maxVolume;
}
```

## Prevention

Client-side validation should mirror server-side validation for all inventory operations. When server-side logic is updated (e.g., adding nested inventory), corresponding client-side checks must be updated in tandem.

## References

- Related wiki: `wiki/nested_inventory_design.md`
- Related controller: `InventoryManager` (client-side)
