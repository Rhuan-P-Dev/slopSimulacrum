# BUG-023: Range Indicator Ignores Synergy Multiplier

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `22bf5dc`
- **Related Files**: `public/js/App.js` (lines 43-48, 109-116, 268-293, 312-348)

## Symptoms

When selecting 2+ components for 'move' or 'dash' actions, the range indicator (white dashed circle) did not reflect the synergy bonus. The range stayed at the base `Movement.move` value even though synergy was boosting the actual movement distance.

Example: With synergy of 1.5x and move stat of 20:
- Expected range: 30 (20 × 1.5)
- Actual range shown: 20

## Root Cause

The `_calculateActionRange()` method in `App.js` calculated range from the raw `Movement.move` stat only, completely ignoring the synergy multiplier:

```javascript
// Broken: ignores synergy
const moveStat = /* from first component found */;
return isDash ? moveStat * AppConfig.MULTIPLIERS.DASH_RANGE : moveStat;
```

The synergy result was available in the preview but not passed to the range calculation.

## Fix

1. Added `currentSynergyResult` property to `ClientApp` to store the current synergy preview result.
2. Updated `_updateSynergyPreview()` to store `preview.synergyResult` in `this.currentSynergyResult`.
3. Updated `_calculateActionRange()` to accept a `synergyMultiplier` parameter and apply it:

```javascript
// App.js
_calculateActionRange(actionName, droid, state, synergyMultiplier = 1.0) {
    // ...
    // Use the component with the highest move stat for synergy calculation
    let maxMoveStat = null;
    for (const comp of droid.components) {
        const stats = state.components.instances[comp.id];
        if (stats && stats.Movement && stats.Movement.move !== undefined) {
            if (maxMoveStat === null || stats.Movement.move > maxMoveStat) {
                maxMoveStat = stats.Movement.move;
            }
        }
    }
    
    // Apply synergy multiplier to the move stat before calculating range
    const effectiveMove = maxMoveStat * synergyMultiplier;
    return isDash ? effectiveMove * AppConfig.MULTIPLIERS.DASH_RANGE : effectiveMove;
}
```

4. Updated `updateActionList()` to pass the synergy multiplier from `currentSynergyResult`.

## Prevention

When UI elements reflect computed values (like range), ensure all modifiers (synergy, buffs, etc.) are applied in the calculation chain. Document expected input parameters for calculation methods.

## References

- Related wiki: `wiki/subMDs/synergy_preview.md`
- Related wiki: `wiki/subMDs/client_ui.md`
- Related controller: `ClientApp`