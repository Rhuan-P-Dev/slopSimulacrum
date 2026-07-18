# BUG-121: components.json Repeatedly Loaded on Every Volume Check

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: Current implementation (cached in constructor)
- **RelatedFiles**: [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js) (lines 20-25, 66-78, 318-336)

## Symptoms

`DataLoader.loadJsonSafe('data/components.json', {})` was called inside `_getComponentMaxVolume()` and `_getComponentMaxVolumeFromEntity()`, which are invoked on every `addItem` and `moveItem` call. This caused redundant file reads and unnecessary I/O overhead on every inventory operation.

## Root Cause

The component definitions were not cached at the InventoryManager level. Each volume check triggered a fresh file load, even though `components.json` is static data that rarely changes.

## Fix

Added `this._componentDefinitions` property loaded once in the constructor. Both methods now use the cached reference:

```javascript
// In constructor:
constructor() {
    this._items = {};
    this._containers = {};
    this._componentDefinitions = DataLoader.loadJsonSafe('data/components.json', {});
}

// In methods:
_getComponentMaxVolume(componentId) {
    const def = this._componentDefinitions[componentId];
    if (!def) return 0;
    return def.maxVolume || 0;
}
```

## Prevention

Stateless utility methods that need repeated data access should cache data at the class level. Static configuration files should be loaded once and reused throughout the application lifecycle.

## References

- Related wiki: `wiki/nested_inventory_design.md`
- Related controller: `InventoryManager`
