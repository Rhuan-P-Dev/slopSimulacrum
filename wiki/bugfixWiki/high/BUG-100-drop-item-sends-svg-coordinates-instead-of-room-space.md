# BUG-100: Drop Item Coordinates Offset from Target Location

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `public/js/EventDispatcher.js` (lines 142-143), `public/js/ActionExecutor.js` (lines 328-439)

## Symptoms

When the user drops an item on the spatial map, the item appears at an incorrect position, offset from where the user clicked. The drop appears to be displaced by approximately 300px in X and 150px in Y from the actual target location.

## Root Cause

The drop item click handler in `EventDispatcher.js` used the **wrong coordinate transformation** compared to regular spatial actions (dash, move): while all regular spatial flows convert the click position relative to the room center (`CENTER_X=400`, `CENTER_Y=250` — the room SVG centers the room at the middle of its `800x500` viewBox), the drop handler subtracted a hardcoded `100` offset that was designed for the **world map overlay**. This produced a constant mismatch of **300px in X** and **150px in Y** from the clicked point.

**Additionally**, `ActionExecutor.js` carried leftover room-space conversion logic designed for the old incorrect coordinate system, which was never needed.

## Fix

### 1. EventDispatcher.js (lines 142-143)
Changed the drop item coordinate transformation to use the same room-center offset (CENTER_X/CENTER_Y) as the regular spatial action flow, so drops land exactly where the user clicked.

### 2. ActionExecutor.js (executeDropItem method)
Simplified the method to use coordinates directly (relative to room center), matching the coordinate system used by:
- `SpatialConsequenceHandler` for dash/move actions
- `UIManager._renderEntities()` for entity rendering
- `UIManager.renderDroppedItemsOnSpatialMap()` for dropped item rendering

The unnecessary room-space conversion and its dead comments were removed. Rationale: every map-based flow must share one coordinate convention — per-flow custom transforms are exactly how offset mismatches like this arise.

## Prevention

1. **Coordinate System Consistency**: All map-based actions should use the same coordinate system relative to the room center (CENTER_X, CENTER_Y).
2. **Shared Transform Formula**: When multiple action types target the same SVG element, ensure they all use the same coordinate transformation.
3. **Test with Visual Feedback**: Always verify dropped items appear at the clicked position during QA.

## References
- Related wiki: `wiki/subMDs/systems/item_drop_pickup.md`
- Related controllers: `EventDispatcher`, `ActionExecutor`, `SpatialConsequenceHandler`
- Related bugs: BUG-082 (dropped items render off-screen), BUG-083 (drop item distance check coord mismatch)