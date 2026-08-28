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

The `_calculateActionRange()` method in `App.js` calculated range from the raw `Movement.move` stat only, completely ignoring the synergy multiplier. The synergy result was available in the preview but not passed to the range calculation.

## Fix

The client now retains the current synergy preview result and passes its multiplier into the range calculation (based on the highest move stat among the selected components), so the indicator reflects the effective, synergy-boosted range.

## Prevention

When UI elements reflect computed values (like range), ensure all modifiers (synergy, buffs, etc.) are applied in the calculation chain. Document expected input parameters for calculation methods.

## References

- Related wiki: `wiki/subMDs/synergy_preview.md`
- Related wiki: `wiki/subMDs/client_ui.md`
- Related controller: `ClientApp`