# BUG-078: Overlay Panel Data Flow Regression — Component Viewer and Actions Panel Show Empty Content

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `OverlayManager.js`, `App.js`, `ComponentViewer.js`, `NavActionsPanel.js`

## Symptoms

When clicking the Component Viewer or Actions config bar buttons, the panels display:
- Component Viewer: "No components found for this entity."
- Actions Panel: "No actions available."

## Root Cause

ConfigBarManager was deleted during the OverlayManager implementation without auditing the data-fetching logic it contained. This is a common pattern when removing delegation layers: the structural relationship changes but the behavioral dependencies remain hidden until they break at runtime.

The OverlayManager's `register()` method only stored a controller reference — it had no mechanism to fetch data before showing a panel. This is architecturally correct for a coordinator (it should not know about data fetching), but the data-fetching responsibility was lost when the delegation layer was removed without being transferred to an appropriate owner.

## Fix

**Data-fetching responsibility transferred to the caller.** The `showData` callback pattern was added to `register()` because the entity that knows about both the OverlayManager and the data source (App.js) is the appropriate owner of cross-module data coordination. The OverlayManager's role is lifecycle management; the caller's role is providing the data. This maintains the single-responsibility boundary while ensuring data availability.

**Panel `show()` methods accept structured data objects with legacy fallback.** The `{ entity, state }` and `{ actions, entityId, onActionClick }` data objects decouple the data shape from the call signature. Legacy positional argument fallback ensures backward compatibility during transition. This prevents breakage when callers evolve their data-fetching strategy.

**Why the caller owns data-fetching, not the coordinator:** The OverlayManager does not have access to world state or API endpoints. Only App.js — the orchestrator — has both. Therefore, the showData callback must be supplied by whoever constructs the registration, not implemented inside the manager.

## Prevention

- When refactoring or removing controllers, audit all dependent panel calls for data-fetching logic
- Always verify that removed delegation layers don't contain critical business logic
- Panel `show()` methods should validate data availability and provide meaningful error messages

## References
- Related wiki: `wiki/subMDs/frontend/overlay_manager.md`
- Related controller: `OverlayManager`
- Related bug: `BUG-077` (original overlay manager implementation that introduced this regression)