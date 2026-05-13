# BUG-063: WorldMapView init() not called in ClientApp

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: —
- **Related Files**: `public/js/App.js` (lines ~165-170)

## Symptoms

The 🌐 World Map button appears in the config bar, but clicking it may fail to display the overlay properly. The `WorldMapView._overlay` reference remains `null` because `init()` was never called, causing `show()` to silently return without rendering.

## Root Cause

In `ClientApp.init()`, the `worldMap.init()` method is not called alongside the other module initializations (`statBars.init()`, `componentViewer.init()`, `navActions.init()`, `configBar.init()`). This means `WorldMapView._overlay` is never set to the DOM element.

## Fix

Add `this.worldMap.init()` to the `ClientApp.init()` method:

```javascript
async init() {
    console.log('%c[ClientApp] 🚀 Initializing System...', 'color: #00ff00; font-weight: bold;');
    try {
        // Initialize new modules
        this.statBars.init();
        this.componentViewer.init();
        this.navActions.init();
        this.configBar.init();
        this.worldMap.init();  // ← ADD THIS LINE
        await this.refreshWorldAndActions();
    } catch (error) {
        // ...
    }
}
```

## Prevention

When adding new overlay/view modules to `ClientApp`, ensure `init()` is called during boot sequence alongside other modules. Document this pattern in the client architecture wiki.

## References
- Related wiki: `wiki/subMDs/world_map.md`
- Related controller: `WorldMapView`
- Related controller: `ClientApp`

