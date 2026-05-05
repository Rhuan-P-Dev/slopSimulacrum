# BUG-046: _evaluateProvidedComponents doesn't populate contributingComponents

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/synergyController.js`

## Symptoms
- Synergy multiplier is correctly computed (e.g., 1.95x for 2 rolling balls) but `contributingComponents` array is empty
- UI shows `"Synergy: 1.95x, 0 components"` instead of `"Synergy: 1.95x, 2 components"`
- Range indicator doesn't show component icons for synergy preview

## Root Cause
The `_evaluateProvidedComponents` method computed the correct multiplier but didn't populate the `contributingComponents` array. When `providedComponentIds` was used (preview endpoint), the method skipped the population loop that exists in `_evaluateComponentGroups`.

## Fix
Modified `_evaluateProvidedComponents` to:
1. Accept `contributingComponents` as a parameter
2. Add members to contributingComponents after filtering
3. Deduplicate members using `calculator.deduplicate()`

```javascript
_evaluateProvidedComponents(actionName, entityId, providedComponentIds, config, contributingComponents) {
    let totalMultiplier = 1.0;
    for (const groupDef of config.componentGroups) {
        const members = this._filterProvidedForGroup(actionName, entityId, providedComponentIds, groupDef);
        if (members.length < groupDef.minCount) continue;
        const multiplier = this.calculator.computeMultiplier(...);
        totalMultiplier *= multiplier;
        for (const member of members) {
            contributingComponents.push({
                componentId: member.componentId,
                entityId: member.entityId,
                componentType: member.componentType,
                contribution: multiplier / members.length
            });
        }
    }
    const unique = this.calculator.deduplicate(contributingComponents);
    contributingComponents.length = 0;
    contributingComponents.push(...unique);
    return totalMultiplier;
}
```

Also updated the call site to pass `contributingComponents`:
```javascript
totalMultiplier *= this._evaluateProvidedComponents(
    actionName, entityId, context.providedComponentIds, config, contributingComponents
);
```

## Prevention
- When adding logic to compute values, always ensure the side-effect of populating contributing data is also handled.
- Add unit tests that verify both `synergyMultiplier` and `contributingComponents` arrays.

## References
- Related wiki: `wiki/subMDs/synergy_system.md`, `wiki/subMDs/synergy_preview.md`
- Related bug: BUG-042 (SynergyController SRP refactoring), BUG-022 (duplicate contributing components)