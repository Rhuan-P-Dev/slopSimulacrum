# BUG-112: Equipment ID (eq-*) Not Resolved in Synergy System

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
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

Six raw `entity.components.find(...)` lookups were affected: three in `SynergyController._filterProvidedForGroup()`, two in `SynergyComponentGatherer.gatherSameComponentType()`, and one in `SynergyComponentGatherer.gatherAllComponents()`.

## Impact

- **Synergy Multiplier**: Actions with equipped items get 1.0x multiplier instead of the correct value
- **Damage Calculation**: Damage is calculated without synergy, resulting in lower values
- **User Experience**: Players don't see expected synergy bonuses when using equipped items

## Fix

### 1. Added ID Resolution Helper to `SynergyComponentGatherer`

Added a `_resolveToComponentId()` helper that resolves `eq-*` IDs to their host `comp-*` ID via the equipped item record, leaves `comp-*` IDs untouched, and logs a warning when an equipment ID cannot be resolved.

### 2. Updated `gatherSameComponentType()` in `SynergyComponentGatherer`

The component lookup now uses the helper-resolved ID instead of the raw selection ID.

### 3. Updated `gatherAllComponents()` in `SynergyComponentGatherer`

Same pattern — resolve equipment IDs before component lookup.

### 4. Updated `_filterProvidedForGroup()` in `SynergyController`

All three lookup sites now resolve `eq-*` IDs to their host component before the `entity.components` lookup, skipping any entry whose equipment ID cannot be resolved.

### 5. Added IdResolver Import to `SynergyController`

The controller now imports the shared `IdResolver` utility so it can distinguish `comp-*` from `eq-*` IDs before lookup.

## Prevention

1. **Centralized ID Resolution**: Create a utility function that resolves any ID type to a component ID
2. **Consistent Validation**: All code that looks up components by ID should use the same resolution logic
3. **Test Coverage**: Add tests for synergy with equipped items
4. **Documentation**: Document that synergy system needs to handle both `comp-*` and `eq-*` IDs

## References

- Related bug: [BUG-111](high/BUG-111-equipment-id-not-resolved-in-selection-system.md)
- Related controller: `SynergyController`
- Related controller: `ActionSelectController`
