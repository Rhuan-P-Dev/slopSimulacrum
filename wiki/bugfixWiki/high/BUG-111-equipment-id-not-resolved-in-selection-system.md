# BUG-111: Equipment ID (eq-*) Not Resolved in Component Selection System

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `actionSelectController.js`, `selectionRoutes.js`, `actionController.js`, `WorldStateController.js`

## Symptoms

When a user equips an item (e.g., knife) and then tries to use an action that requires that equipped item (e.g., "cut" action):

1. **Server Log Warning**:
```
⚠️ WARN: [ActionSelectController] Invalid component ID format in batch: "eq-f1e132d2-e1f6-4622-a6cc-ec5b224ddc3b".
```

2. The action fails because the server rejects the equipment ID (`eq-*`) as an invalid component ID format.

3. The client shows the error but the action is not executed.

## Root Cause

The component capability system (`ComponentCapabilityController`) returns capability entries where equipped items use the typed `eqId` (e.g., `eq-f1e132d2-...`) as the `componentId` field. When the client selects this component for an action, it sends the `eq-*` ID to the server.

However, the `ActionSelectController` only accepted `comp-*` (component) IDs and rejected `eq-*` (equipment) IDs as invalid format. This caused the selection lock to fail, and subsequently the action execution to fail.

The ID resolution gap existed because:
1. The `ComponentCapabilityController` correctly uses `eq-*` IDs for equipped item entries
2. The `ActionSelectController` did not have logic to resolve `eq-*` IDs to their host `comp-*` IDs
3. The selection routes validated component IDs but only accepted `comp-*` format

## Fix

### 1. Added ID Resolution Helper to `ActionSelectController`

Added `_resolveToComponentId()` method that resolves equipment IDs to their host component IDs:

```javascript
_resolveToComponentId(id, entityId) {
    if (!id) {
        return { resolvedId: null, wasEquipped: false };
    }

    // If already a component ID, return as-is
    if (IdResolver.isCompId(id)) {
        return { resolvedId: id, wasEquipped: false };
    }

    // If an equipment ID, resolve to host component
    if (IdResolver.isEquippedId(id)) {
        const equippedItem = this.worldStateController.getEquippedItem(entityId, id);
        if (equippedItem && equippedItem.componentId) {
            Logger.info('[ActionSelectController] Resolved equipment ID to component ID', {
                eqId: id,
                componentId: equippedItem.componentId
            });
            return { resolvedId: equippedItem.componentId, wasEquipped: true };
        }
        Logger.warn('[ActionSelectController] Equipment ID not found for resolution', { eqId: id, entityId });
        return { resolvedId: null, wasEquipped: true };
    }

    // Unknown ID type — return as-is (will fail validation later)
    return { resolvedId: id, wasEquipped: false };
}
```

### 2. Updated Selection Methods to Use Resolution

Modified the following methods to resolve equipment IDs before validation/locking:

- `registerSelection(actionName, componentId, entityId, role)` - Now resolves eq-* IDs before locking
- `registerSelections(actionName, entityId, componentList)` - Batch version also resolves eq-* IDs
- `validateSelection(componentId, actionName, entityId)` - Validates resolved IDs
- `validateSelections(actionName, componentIds, entityId)` - Batch validation resolves eq-* IDs
- `releaseSelection(componentId, entityId)` - Releases by resolved comp-* ID
- `releaseSelections(componentIds, entityId)` - Batch release resolves eq-* IDs

### 3. Updated Selection Routes

Modified `selectionRoutes.js` to accept both `comp-*` and `eq-*` IDs:

```javascript
// Accept both comp-* (component IDs) and eq-* (equipped item IDs)
const isCompId = IdResolver.isCompId(compId);
const isEquippedId = IdResolver.isEquippedId(compId);
if (!isCompId && !isEquippedId) {
    return res.status(400).json({
        success: false,
        error: `Invalid component ID format: "${compId}". Expected comp-* or eq-* format.`
    });
}
```

### 4. Updated Call Sites in `actionController.js`

Updated all calls to selection methods to pass `entityId` for equipment resolution:

```javascript
// Validation
this.actionSelectController.validateSelections(actionName, componentList.map(c => c.componentId), entityId)
this.actionSelectController.validateSelection(sourceComponentId, actionName, entityId)

// Release
this.actionSelectController.releaseSelections(componentsToRelease, entityId)
```

### 5. Updated `ComponentResolver.js`

Modified `buildComponentList()` and `resolveSourceComponent()` to accept both `comp-*` and `eq-*` IDs:

```javascript
// Accept typed component IDs (comp-...), equipped item IDs (eq-...), and legacy raw UUIDs
if (IdResolver.isCompId(compId) || IdResolver.isEquippedId(compId) || this._isLegacyCompId(compId)) {
    // ...
}
```

### 6. Updated `actionController.js` Validation

Updated attacker component ID validation to accept `eq-*` IDs:

```javascript
if (!IdResolver.isCompId(atkId) && !IdResolver.isEquippedId(atkId) && !this._isLegacyCompId(atkId)) {
    // reject
}
```

## Prevention

1. **Unified ID Resolution**: Any method that accepts component IDs should use `_resolveToComponentId()` to handle both `comp-*` and `eq-*` IDs transparently.

2. **Route Validation**: Selection routes should validate that IDs are either `comp-*` or `eq-*` format, not just `comp-*`.

3. **EntityId Propagation**: Methods that need to resolve equipment IDs must have access to `entityId`. Ensure `entityId` is passed through the call chain.

4. **Documentation**: Document that capability entries use `eq-*` IDs for equipped items, and that consumers should handle this appropriately.

## References

- Related wiki: `wiki/subMDs/typed_id_adoption.md`
- Related controller: `ActionSelectController`
- Related controller: `ComponentCapabilityController`
- Related controller: `HoldingCostController`
