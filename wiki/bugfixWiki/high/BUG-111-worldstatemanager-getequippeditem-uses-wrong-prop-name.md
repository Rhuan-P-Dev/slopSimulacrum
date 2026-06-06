# BUG-111: WorldStateManager.getEquippedItem() Uses Wrong Property Name for EqId Lookup

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `typed-id-equipped-bugs-fix`
- **Related Files**: `public/js/WorldStateManager.js` (line 128)

## Symptoms

1. **Knife not selected when clicked in ⚔️ Actions panel**: Clicking on the knife entry under "cut" action had no effect — the knife was not selected for cutting.
2. **Silent failure**: The `_handleEquippedItemClick` method in `App.js` called `this.worldState.getEquippedItem(entityId, eqId)` which returned `null`, causing an early return without any error or warning.
3. **Component targeting flow broken**: Because the equipped item was not found, `selection.toggleComponent()` was never called, so the knife never appeared in the selected components.

## Root Cause

`WorldStateManager.getEquippedItem(entityId, eqId)` in `public/js/WorldStateManager.js` was checking `eq.id === eqId`, but equipped item objects from the backend use `eq.eqId` as the typed ID field (e.g., `eq-550e8400-e29b-41d4-a716-446655440000`), not `eq.id`.

```javascript
// BEFORE (WRONG):
getEquippedItem(entityId, eqId) {
    // ...
    return entity.equipped.find(eq => eq.id === eqId) || null;  // ← eq.id doesn't exist
}

// AFTER (FIXED):
getEquippedItem(entityId, eqId) {
    // ...
    return entity.equipped.find(eq => eq.eqId === eqId) || null;  // ← eq.eqId is the typed ID
}
```

The equipped item objects have this structure (from the backend):
```javascript
{
    eqId: "eq-550e8400-e29b-41d4-a716-446655440000",  // ← typed eq-uuid
    itemId: "item-abc123",
    itemType: "knife",
    componentId: "comp-def456",
    entityId: "ent-ghi789"
}
```

## Click Flow Analysis

1. User clicks knife entry in ⚔️ Actions panel
2. NavActionsPanel reads `data-comp-id="eq-xxx"` → calls callback with eqId
3. App.js `_setupActionCallback` detects `isEquippedId(componentId)` → calls `_handleEquippedItemClick`
4. `_handleEquippedItemClick` calls `worldState.getEquippedItem(entityId, eqId)` → **BUG: returns null**
5. Method silently returns without selecting anything

## Fix

Changed line 128 in `public/js/WorldStateManager.js` from `eq.id` to `eq.eqId`.

## Prevention

1. When searching equipped items by typed ID, always use `eq.eqId`, not `eq.id`
2. Verify the actual property names of data structures before writing comparison logic
3. Add console logging for silent failures in the equipped item lookup flow

## Verification

Searched entire codebase for `eq.id ===` and `eq.id ==` patterns — no other occurrences found in either frontend (`public/js/`) or server (`src/`) code.

## References

- Related wiki: `wiki/subMDs/systems/typed_id_adoption.md`
- Related bug: `wiki/bugfixWiki/high/BUG-109-equipped-item-stats-lookup-and-merge-issues.md`
- Related bug: `wiki/bugfixWiki/high/BUG-110-requirement-resolver-equipped-stats-replace-instead-of-merge.md`