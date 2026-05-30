# BUG-100: Drop Item Coordinates Offset from Target Location

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/EventDispatcher.js` (lines 142-143), `public/js/ActionExecutor.js` (lines 328-439)

## Symptoms

When the user drops an item on the spatial map, the item appears at an incorrect position, offset from where the user clicked. The drop appears to be displaced by approximately 300px in X and 150px in Y from the actual target location.

## Root Cause

The drop item click handler in `EventDispatcher.js` used the **wrong coordinate transformation formula** compared to regular spatial actions (dash, move):

```javascript
// BROKEN: Drop items used world map offset (hardcoded 100)
const targetX = svgP.x - 100;
const targetY = svgP.y - 100;

// WORKING: Regular spatial actions use room center offset (CENTER_X=400, CENTER_Y=250)
const targetX = svgP.x - this.config.VIEW.CENTER_X;
const targetY = svgP.y - this.config.VIEW.CENTER_Y;
```

**Coordinate System Analysis:**

The main room SVG (`#world-map`) uses a viewBox of `800x500` and centers the room at `(400, 250)` (CENTER_X, CENTER_Y). Entity positions are rendered as:
```javascript
entityX = CENTER_X + entity.spatial.x   // = 400 + spatial.x
entityY = CENTER_Y + entity.spatial.y   // = 250 + spatial.y
```

The drop item handler used `svgP.x - 100` which was designed for the **world map overlay** (which uses `translate(-minX + 100, -minY + 100)`). This created a coordinate mismatch:
- X offset: 400 - 100 = **300px wrong**
- Y offset: 250 - 100 = **150px wrong**

**Additionally**, `ActionExecutor.js` had complex room-space conversion logic (`targetRoomSpaceX = targetX + minX`) that was designed for the old incorrect coordinate system and was never needed.

## Fix

### 1. EventDispatcher.js (lines 142-143)
Changed the drop item coordinate transformation to use CENTER_X/CENTER_Y, matching the regular spatial action flow:

```javascript
// Before (bug):
const targetX = svgP.x - 100;
const targetY = svgP.y - 100;

// After (fixed):
const targetX = svgP.x - this.config.VIEW.CENTER_X;
const targetY = svgP.y - this.config.VIEW.CENTER_Y;
```

### 2. ActionExecutor.js (executeDropItem method)
Simplified the method to use coordinates directly (relative to room center), matching the coordinate system used by:
- `SpatialConsequenceHandler` for dash/move actions
- `UIManager._renderEntities()` for entity rendering
- `UIManager.renderDroppedItemsOnSpatialMap()` for dropped item rendering

Removed the unnecessary room-space conversion (`targetRoomSpaceX = targetX + minX`) and related dead comments.

## Prevention

1. **Coordinate System Consistency**: All map-based actions should use the same coordinate system relative to the room center (CENTER_X, CENTER_Y).
2. **Shared Transform Formula**: When multiple action types target the same SVG element, ensure they all use the same coordinate transformation.
3. **Test with Visual Feedback**: Always verify dropped items appear at the clicked position during QA.

## References
- Related wiki: `wiki/subMDs/systems/item_drop_pickup.md`
- Related controllers: `EventDispatcher`, `ActionExecutor`, `SpatialConsequenceHandler`
- Related bugs: BUG-082 (dropped items render off-screen), BUG-083 (drop item distance check coord mismatch)