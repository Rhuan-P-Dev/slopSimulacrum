# BUG-063: WorldMapView init() not called in ClientApp

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: —
- **Related Files**: `public/js/App.js` (lines ~165-170)

## Symptoms

The 🌐 World Map button appears in the config bar, but clicking it may fail to display the overlay properly — the map overlay silently fails to render.

## Root Cause

In `ClientApp.init()`, the `worldMap.init()` method is not called alongside the other module initializations (`statBars.init()`, `componentViewer.init()`, `navActions.init()`, `configBar.init()`). This means `WorldMapView._overlay` is never set to the DOM element, so when `show()` is invoked the overlay reference is still `null` and it silently returns without rendering.

## Fix

The `worldMap.init()` call was added to the `ClientApp.init()` boot sequence so the World Map view is initialized alongside every other module. This ensures the overlay reference is bound to the DOM element before any button can trigger `show()`.

## Prevention

When adding new overlay/view modules to `ClientApp`, ensure `init()` is called during boot sequence alongside other modules. Document this pattern in the client architecture wiki.

## References
- Related wiki: `wiki/subMDs/world_map.md`
- Related controller: `WorldMapView`
- Related controller: `ClientApp`

