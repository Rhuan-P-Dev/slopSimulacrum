# BUG-055: NavActionsPanel Navigation Buttons Non-Functional (Listeners Never Attached)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/NavActionsPanel.js` (lines 43-65, 171-182)

## Symptoms

- Clicking navigation buttons (e.g., "Go Entrance Hall") in the 👍 Nav/Actions panel does nothing
- No network requests are sent when clicking nav buttons
- The room never changes even when connections exist

## Root Cause

The `_attachNavListeners()` method was defined in `NavActionsPanel.js` (line 171) but **never called** after the panel rendered. The `show()` method built the navigation buttons via `_buildNavSection()` but did not invoke `_attachNavListeners()` to attach the `onclick` handlers.

```
NavActionsPanel.show()
  → _buildNavSection() creates <button class="nav-btn" data-target="..."> ✅
  → _attachNavListeners() is NEVER called ❌
  → Buttons exist but have no click handlers
```

Additionally, the `toggle()` method also did not accept or pass the `onActionClick` callback.

## Fix

**File:** `public/js/NavActionsPanel.js`

1. Added `onActionClick` parameter to `show()` and `toggle()` methods
2. Called `_attachNavListeners()` and `_attachActionListeners()` at the end of `show()` after DOM rendering
3. Added `_attachActionListeners()` method to handle action item clicks

```javascript
// Before: show() never called _attachNavListeners()
show(room, actions, entityId, onNavClick) {
    // ... builds DOM ...
    this._content.innerHTML = html;
    this._overlay.style.display = 'block';
    // _attachNavListeners() was never called!
}

// After: listeners are attached after DOM rendering
show(room, actions, entityId, onNavClick, onActionClick) {
    // ... builds DOM ...
    this._content.innerHTML = html;
    this._overlay.style.display = 'block';
    this._attachNavListeners();       // ← NEW
    this._attachActionListeners();    // ← NEW
}
```

## Prevention

1. **Verify listener attachment**: After building DOM elements, always verify that event listeners are attached
2. **Test interactivity**: Include interaction tests in addition to rendering tests
3. **Use consistent patterns**: Ensure all panel classes follow the same init/show/render/listeners pattern

## References
- Related wiki: `wiki/subMDs/client_ui.md`
- Related manager: `NavActionsPanel`, `ConfigBarManager`, `ActionExecutor`
- Server route: `src/routes/worldRoutes.js` (POST /move-entity)