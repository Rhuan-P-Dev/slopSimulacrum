# BUG-048: Dash with 1 Component Moves 4x and Falsely Triggers 2-Component Synergy

- **Severity**: MEDIUM
- **Status**: ✅ Fixed (Round 2)
- **Fixed In**: `pending`
- **Related Files**:
  - `src/controllers/SynergyComponentGatherer.js` (lines 34-101)
  - `src/controllers/synergyController.js` (lines 64-98, 158-210, 223-262)
  - `data/synergy.json` (lines 18-41)

## Symptoms

With 1 component:
1. Entity has 1 `droidRollingBall` (move=10)
2. Dash action triggers
3. Synergy multiplier incorrectly computed as > 1.0
4. Total multiplier = **1.0**

With 2 components (but only 1 selected):
1. Entity has 2 `droidRollingBall` components
2. Only 1 is selected for the action
3. Synergy incorrectly includes both (multiplier = 1.5)
4. Final speed = 10 × 2 × 1.5 = **30** (should be 20)

## Root Cause

The `SynergyComponentGatherer` methods gathered **ALL matching components on the entity**, not just the source component that was selected. For spatial actions, component selection validation is skipped (so no components are locked), meaning ALL Movement components on the entity contribute to synergy even when only 1 was selected.

**Data flow:**
1. `actionController.executeAction()` → `computeSynergy()` with `sourceComponentId` but no `providedComponentIds`
2. `synergyController._evaluateComponentGroups()` → `_gatherGroupMembers()` → `gatherSameComponentType()`
3. `gatherSameComponentType()` with `sourceComponentId` → only includes source + same-type siblings
4. But siblings were NOT filtered by `allowedComponentIds`, so ALL same-type siblings counted

**Expected behavior:**
- 1 droidRollingBall: synergy = 1.0x → speed = 20
- 2 droidRollingBalls: synergy = 1.5 × 1.3 = 1.95x → speed = 39

**Actual behavior before fix:**
- 1 droidRollingBall: synergy = 1.5 × 1.3 = 1.95x → speed = 39 ❌
- 2 droidRollingBalls: synergy = 1.5 × 1.3 = 1.95x → speed = 39 ✅

## Fix (Round 2: Post groupType Unification)

### 1. `SynergyComponentGatherer.js` — Add `allowedComponentIds` filtering

All gather methods now accept an `allowedComponentIds` parameter. When provided (from `providedComponentIds`), only those specific component IDs count toward synergy — not all same-type siblings on the entity.

```javascript
// Example: gatherSameComponentType with allowedComponentIds
gatherSameComponentType(entity, groupDef, roleFilter, lockedComponentIds, sourceComponentId, allowedComponentIds) {
    // ...source logic...
    for (const comp of entity.components) {
        if (comp.id === sourceComponentId) continue;
        if (lockedComponentIds.has(comp.id)) continue;
        if (comp.type !== detectedType) continue;
        if (allowedComponentIds && !allowedComponentIds.has(comp.id)) continue; // NEW: filter siblings
        // ...
    }
}
```

### 2. `synergyController.js` — Add type filtering and `allowedComponentIds`

#### a) `_filterProvidedForGroup`: Auto-detect component type
```javascript
_filterProvidedForGroup(actionName, entityId, providedComponentIds, groupDef) {
    let detectedType = null;
    const validComponents = providedComponentIds
        .filter(({ componentId, role }) => {
            // ...role filter...
            if (detectedType === null) detectedType = component.type; // NEW: auto-detect type
            return component.type === detectedType; // NEW: same-type filter
        })
        .map(...);
}
```

#### b) `computeSynergy`: Build `allowedComponentIds` set
```javascript
let allowedComponentIds = null;
if (providedComponentIds && providedComponentIds.length > 0) {
    allowedComponentIds = new Set(providedComponentIds.map(c => c.componentId));
}
```

#### c) `_gatherGroupMembers`: Pass `allowedComponentIds` to gatherer
```javascript
return this.componentGatherer.gatherSameComponentType(
    entity, groupDef, roleFilter, lockedComponentIds, sourceComponentId, allowedComponentIds
);
```

### 3. `data/synergy.json` — Change groupType to `sameComponentType`

All `groupType` values now use `"sameComponentType"`. The `componentType` field has been removed — type is auto-detected from the source component at runtime.

```json
{
    "groupType": "sameComponentType",
    "minCount": 2,
    "scaling": "linear",
    "baseMultiplier": 1.0,
    "perUnitBonus": 0.5,
    "roleFilter": "source",
    "description": "Multiple droidRollingBall components on the same entity boost dash distance."
}
```

### 4. `actionController.js` — Pass `sourceComponentId` to preview

`previewActionData()` now adds `sourceComponentId` to the context before calling `computeSynergy()`, ensuring synergy previews match actual execution.

```javascript
synergyResult = this.synergyController.computeSynergy(actionName, entityId, {
    ...context,
    sourceComponentId: resolveComponentId
});
```

### 5. `synergyRoutes.js` — Pass `sourceComponentId` in API routes

Both `/synergy/preview` and `/synergy/preview-data` routes now add `sourceComponentId` from `componentIds[0]`.

## Prevention

1. **Gatherer methods must respect `allowedComponentIds`**: When a set of allowed component IDs is provided, only those specific components should count toward synergy — never auto-include all same-type siblings from the entity.

2. **`_filterProvidedForGroup` must auto-detect component type**: Since `componentType` is no longer in synergy config, the filter must detect the type from the first valid component and only include same-type components.

3. **Preview paths must match execution paths**: `previewActionData()` and the `/synergy/preview` API endpoint must pass the same parameters as `executeAction()` to ensure consistent results.

4. **Test with single-component scenarios**: Always verify synergy computation with exactly 1 selected component to ensure the multiplier is 1.0.

## References