# BUG-102: Dead ActionManager Drop Action Methods

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
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

Removed the dead drop-state methods from `ActionManager` and their no-op call sites in `App.js` and `ActionExecutor.js`. Rationale: drop/pickup state has been owned by `App.js` pending-state properties since the refactor, so the `ActionManager` methods were unreachable leftovers writing to a property nothing reads — leaving them in place risks future code trusting the wrong state owner. The pickup range indicator color was also aligned with the pickup flow's visual language.

## Prevention

- When refactoring state management, audit all references to old state properties
- Use search across the codebase before removing methods to verify zero callers
- Document state ownership: `_pendingDropItem` lives in `App.js`, NOT in `ActionManager`

## References
- Related wiki: `wiki/subMDs/systems/item_drop_pickup.md`
- Related wiki: `wiki/subMDs/systems/world_map_pickup.md`
- Related controller: `ActionManager`, `ActionExecutor`