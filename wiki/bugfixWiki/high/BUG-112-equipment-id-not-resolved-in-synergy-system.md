# BUG-112: Equipment ID (eq-*) Not Resolved in Synergy System

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `synergyController.js`, `SynergyComponentGatherer.js`

## Symptoms

When a user selects an equipped item (e.g., knife) for an action that has synergy (e.g., "cut" with multi-component synergy):

1. **Silent Failure**: The synergy system fails to include the equipped item in the synergy calculation
2. **No Error Message**: The action executes but with incorrect synergy multiplier (typically 1.0x instead of the expected value)
3. **Incorrect Damage**: Damage values are lower than expected because synergy isn't applied

## Root Cause

The synergy system (`SynergyController` and `SynergyComponentGatherer`) looks up components by ID using `entity.components.find(c => c.id === componentId)`. This only works for `comp-*` IDs (body parts), not `eq-*` IDs (equipped items).

When an equipped item is selected:
1. The client sends `eq-abc123...` as the component ID
2. The synergy system tries to find this ID in `entity.components`
3. The lookup fails because equipment IDs are not in the components array
4. The equipped item is excluded from synergy calculation

### Affected Code Paths

**`SynergyController._filterProvidedForGroup()`** (3 occurrences):
```javascript
// Line 212, 223, 239
const component = entity.components.find(c => c.id === componentId);
```

**`SynergyComponentGatherer.gatherSameComponentType()`** (2 occurrences):
```javascript
// Line 39, 140
const sourceComponent = entity.components.find(c => c.id === sourceComponentId);
```

**`SynergyComponentGatherer.gatherAllComponents()`** (1 occurrence):
```javascript
// Line 140
const sourceComponent = entity.components.find(c => c.id === sourceComponentId);
```

## Impact

- **Synergy Multiplier**: Actions with equipped items get 1.0x multiplier instead of the correct value
- **Damage Calculation**: Damage is calculated without synergy, resulting in lower values
- **User Experience**: Players don't see expected synergy bonuses when using equipped items

## Fix

### 1. Added ID Resolution Helper to `SynergyComponentGatherer`

Added `_resolveToComponentId()` method that resolves equipment IDs to their host component IDs:

```javascript
_resolveToComponentId(id, entityId) {
    if (!id) return null;

    // If already a component ID, return as-is
    if (IdResolver.isCompId(id)) {
        return id;
    }

    // If an equipment ID, resolve to host component
    if (IdResolver.isEquippedId(id)) {
        const equippedItem = this.worldStateController.getEquippedItem(entityId, id);
        if (equippedItem && equippedItem.componentId) {
            return equippedItem.componentId;
        }
        Logger.warn('[SynergyComponentGatherer] Equipment ID not found for resolution', { eqId: id, entityId });
        return null;
    }

    // Unknown ID type — return as-is
    return id;
}
```

### 2. Updated `gatherSameComponentType()` in `SynergyComponentGatherer`

Modified to resolve equipment IDs before looking up components:

```javascript
const resolvedSourceComponentId = this._resolveToComponentId(sourceComponentId, entity.id);

// Use resolved ID for component lookup
const sourceComponent = entity.components.find(c => c.id === resolvedSourceComponentId);
```

### 3. Updated `gatherAllComponents()` in `SynergyComponentGatherer`

Same pattern — resolve equipment IDs before component lookup.

### 4. Updated `_filterProvidedForGroup()` in `SynergyController`

Added inline equipment ID resolution before component lookups:

```javascript
// Resolve equipment IDs to component IDs for lookup
let resolvedId = componentId;
if (IdResolver.isEquippedId(componentId)) {
    const equipped = this.worldStateController.getEquippedItem(entityId, componentId);
    if (equipped && equipped.componentId) {
        resolvedId = equipped.componentId;
    } else {
        continue; // Equipment not found, skip
    }
}

const component = entity.components.find(c => c.id === resolvedId);
```

### 5. Added IdResolver Import to `SynergyController`

```javascript
import IdResolver from '../../utils/IdResolver.js';
```

## Prevention

1. **Centralized ID Resolution**: Create a utility function that resolves any ID type to a component ID
2. **Consistent Validation**: All code that looks up components by ID should use the same resolution logic
3. **Test Coverage**: Add tests for synergy with equipped items
4. **Documentation**: Document that synergy system needs to handle both `comp-*` and `eq-*` IDs

## References

- Related bug: [BUG-111](high/BUG-111-equipment-id-not-resolved-in-selection-system.md)
- Related controller: `SynergyController`
- Related controller: `ActionSelectController`
