# BUG-102: Dead ActionManager Drop Action Methods

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/ActionManager.js`, `public/js/ActionExecutor.js`, `public/js/App.js`

## Symptoms

1. `ActionManager.getPendingDropAction()` — never called anywhere in the codebase
2. `ActionManager.setPendingDropAction()` — called once in App.js but the data was never read back (write without matching read)
3. `ActionExecutor.executePickUpItem()` — called `this.actions.clearPendingDropAction()` which sets `ActionManager._pendingDropAction = null`, but the pickup state lives in `App._pendingPickUpSelector` (no-op)
4. `ActionExecutor.executeDropItem()` — called `this.actions.clearPendingDropAction()` which had no effect on the actual drop state (`App._pendingDropItem`)

## Root Cause

The original drop/pickup refactor introduced state management in `App.js` using `_pendingDropItem` and `_pendingPickUpSelector`, but the old `ActionManager` methods for managing drop action state were left in place. These methods:
- Wrote to a private property (`_pendingDropAction`) that was never read
- Were called as no-ops in the pickup flow where they had zero effect on actual state

## Fix

1. **Removed** from `ActionManager.js`:
   - `clearPendingDropAction()` method (lines 244-248)
   - `setPendingDropAction()` method (lines 254-263)
   - `getPendingDropAction()` method (lines 268-271)

2. **Removed** from `App.js`:
   - Call to `this.actions.setPendingDropAction()` at line 486 (state is managed directly via `this._pendingDropItem`)

3. **Removed** from `ActionExecutor.js`:
   - Dead no-op call to `this.actions.clearPendingDropAction()` in `executePickUpItem()` (lines 372-374)
   - Call to `this.actions.clearPendingDropAction()` in `executeDropItem()` (line 469)

4. **Fixed** range indicator color inconsistency in `executePickUpItem()`: changed `'red'` to `'#44ff44'` to match pickup flow visual language (range=0 so indicator is cleared anyway, but consistency matters)

## Prevention

- When refactoring state management, audit all references to old state properties
- Use search across the codebase before removing methods to verify zero callers
- Document state ownership: `_pendingDropItem` lives in `App.js`, NOT in `ActionManager`

## References
- Related wiki: `wiki/subMDs/systems/item_drop_pickup.md`
- Related wiki: `wiki/subMDs/systems/world_map_pickup.md`
- Related controller: `ActionManager`, `ActionExecutor`