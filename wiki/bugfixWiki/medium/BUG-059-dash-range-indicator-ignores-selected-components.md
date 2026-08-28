# BUG-059: Dash Range Indicator Ignores Selected Component Count

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/SynergyPreviewController.js`, `public/js/App.js`

## Symptoms

When selecting 2 components to dash, the visual range indicator on the map shows the incorrect (1-component) range instead of the expanded synergy-enhanced range. Conversely, after dashing with 2 components and then selecting only 1 component to dash again, the range indicator incorrectly shows the 2-component synergy-enhanced range.

The range indicator displays stale synergy data from the previous selection instead of the current selection.

## Root Cause

**Race condition between range calculation and synergy cache**:

1. `App.updateActionList()` calculates the range indicator using `this.synergy.getCachedSynergyResult()` — which returns `currentSynergyResult`
2. `currentSynergyResult` is populated **asynchronously** by `_updateSynergyPreview()` which calls `fetchPreview()` → server computes synergy → caches result
3. **The problem**: When the user selects 2 components then deselects to 1, the cache still holds the 2-component synergy result because `onSelectionChange()` runs `updateActionList()` first (synchronously, reading the stale cache) and only then triggers the async preview update that overwrites the cache with the new (1-component) result — so the range is always rendered from the previous selection's synergy.

Additionally, `SynergyPreviewController.calculateRange()` had an early return when action data had an explicit `range` property, completely ignoring the synergy multiplier.

## Fix

### 1. SynergyPreviewController.js — live multiplier computation

A `computeSynergyMultiplier()` method now computes the synergy multiplier from the currently selected components using server-side synergy computation, instead of trusting a possibly-stale cached preview result.

### 2. SynergyPreviewController.js — explicit `range` no longer bypasses synergy

The early return for actions with an explicit `range` property was removed, so the synergy multiplier is always applied in range calculation.

### 3. App.js — range uses live synergy from the current selection

The range indicator is now computed from a live synergy computation over the selected components (awaited before rendering) rather than from the cached synergy result of the previous selection, eliminating the race.

## Prevention

1. **Never use cached synergy for time-sensitive calculations**: Range calculation should always use live selected component data, not stale cache.
2. **Async operations must not block sync operations**: `updateActionList()` should await synergy computation before rendering range.
3. **Clear cache on component deselection**: When component count drops, the cache should be invalidated or recomputed.

## References
- Related wiki: `wiki/subMDs/synergy_system.md`
- Related wiki: `wiki/subMDs/movement_system.md`
- Related controller: `SynergyPreviewController`, `SelectionController`