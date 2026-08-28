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

`_evaluateProvidedComponents` now populates the same `contributingComponents` output (with deduplication) that the group-based path fills. Why: the two evaluation paths share a contract — computing a multiplier must also record *which* components produced it — otherwise the preview endpoint returns a synergy number with no way to display its source, which is exactly what the UI rendered as "0 components".

## Prevention
- When adding logic to compute values, always ensure the side-effect of populating contributing data is also handled.
- Add unit tests that verify both `synergyMultiplier` and `contributingComponents` arrays.

## References
- Related wiki: `wiki/subMDs/synergy_system.md`, `wiki/subMDs/synergy_preview.md`
- Related bug: BUG-042 (SynergyController SRP refactoring), BUG-022 (duplicate contributing components)