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
3. **The problem**: When user selects 2 components, then deselects to 1, the cache still holds the 2-component synergy result because:
   - `onSelectionChange()` calls `updateActionList()` FIRST (synchronous, uses stale cache)
   - Then calls `_updateSynergyPreview()` SECOND (async, updates cache)
   - When going from 2→1 components, the `if (componentIds.length >= 1)` branch is taken, so `_updateSynergyPreview()` runs and overwrites the cache with the new (1-component) result
   - But `updateActionList()` already ran with the OLD (2-component) cached result

Additionally, `SynergyPreviewController.calculateRange()` had an early return when action data had an explicit `range` property, completely ignoring the synergy multiplier.

## Fix

### 1. SynergyPreviewController.js — Added `computeSynergyMultiplier()` method

```javascript
/**
 * Computes the synergy multiplier from a list of component IDs.
 * Uses the server-side synergy computation for accurate results.
 */
async computeSynergyMultiplier(actionName, entityId, componentIds) {
    if (!componentIds || componentIds.length < 1) {
        return 1.0;
    }

    const componentPayload = componentIds.map(compId => ({
        componentId: compId,
        role: 'source'
    }));

    const preview = await this.actions.previewActionData(
        actionName, entityId, componentPayload
    );

    if (preview && preview.synergyResult) {
        const multiplier = parseFloat(preview.synergyResult.synergyMultiplier);
        return isNaN(multiplier) ? 1.0 : multiplier;
    }
    return 1.0;
}
```

### 2. SynergyPreviewController.js — Removed early return for explicit range

```javascript
// BEFORE: returned early if action had explicit range, ignoring synergy
if (actionData && typeof actionData.range === 'number' && actionData.range > 0) {
    return actionData.range;
}

// AFTER: removed — synergy multiplier always applies
```

### 3. App.js — Use live synergy computation for range

```javascript
// BEFORE: used stale cached synergy result
const synergyMultiplier = this.synergy.getCachedSynergyResult()
    ? parseFloat(this.synergy.getCachedSynergyResult().synergyMultiplier) || 1.0
    : 1.0;

// AFTER: computes live synergy from selected components
const selectedIds = this.selection.getSelectedComponentIdsArray();
const synergyMultiplier = selectedIds.length > 0
    ? await this.synergy.computeSynergyMultiplier(pending.actionName, entityId, selectedIds)
    : 1.0;
```

## Data Flow After Fix

```
User selects 2 components for dash
  → SelectionController.toggleComponent() → selectedComponentIds has 2 items
  → onSelectionChange() → updateActionList()
  → computeSynergyMultiplier(dash, entityId, [comp1, comp2]) → server returns 1.5x
  → calculateRange(dash, ..., 1.5) → range = move * 1.5 * DASH_RANGE
  → renderRangeIndicator(droid, correctRange, 'white') ✅

User deselects to 1 component for dash
  → SelectionController.toggleComponent() → selectedComponentIds has 1 item
  → onSelectionChange() → updateActionList()
  → computeSynergyMultiplier(dash, entityId, [comp1]) → server returns 1.0x
  → calculateRange(dash, ..., 1.0) → range = move * 1.0 * DASH_RANGE
  → renderRangeIndicator(droid, correctRange, 'white') ✅
```

## Prevention

1. **Never use cached synergy for time-sensitive calculations**: Range calculation should always use live selected component data, not stale cache.
2. **Async operations must not block sync operations**: `updateActionList()` should await synergy computation before rendering range.
3. **Clear cache on component deselection**: When component count drops, the cache should be invalidated or recomputed.

## References
- Related wiki: `wiki/subMDs/synergy_system.md`
- Related wiki: `wiki/subMDs/movement_system.md`
- Related controller: `SynergyPreviewController`, `SelectionController`