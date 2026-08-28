# BUG-068: Component Viewer Missing Internal Components Display

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/ComponentViewer.js`, `public/css/internal-components.css`, `src/routes/internalComponentRoutes.js`, `wiki/subMDs/internal_components.md`

## Symptoms

1. 🔮 button appears on component cards (render time detects internal components)
2. Clicking 🔮 immediately shows "No internal components"
3. Entity Details view (clicking entity on map) correctly shows internal components

## Root Cause

**Data source mismatch between render and click handler:**

- `_renderComponentGrid()` reads `entity.internalComponents` from the `entity` parameter passed to `show()`. The 🔮 button appears because this source has data.
- `_onToggleInternalComponents()` fetched a **fresh entity** via `getActiveDroid()` which reads from `state.entities[myEntityId]`. This entity may not have `internalComponents` populated (different object reference or stale data).

**Two parallel data sources:**
1. `entity.internalComponents` — populated on the entity object passed to ComponentViewer (has data ✅)
2. `getActiveDroid().internalComponents` — reads from WorldStateManager state (may be empty ❌)

## Fix

The internal-components toggle now reads from the **same entity reference** that was used when the 🔮 button was rendered: the click handler passes `entity.internalComponents` directly to the toggle handler, eliminating the second, potentially stale data source. If the entity reference is unavailable, the handler falls back to fetching from the server.

Supporting this, the Component Viewer gained a dedicated internal-component panel (button, container, and detail cards with human-readable type labels and descriptions), backed by new server endpoints that expose the internal-component type registry and per-host internal components as the fallback data path.

## Prevention

When adding new UI features that display nested data:
1. Always use the same data source for both rendering and interaction
2. Pass data references through event handlers instead of re-fetching
3. Provide API endpoints for fetching nested data
4. Cache fetched data to avoid redundant network requests
5. Use defensive coding for missing data

## References
- Related wiki: `wiki/subMDs/internal_components.md`
- Related controller: `ComponentViewer`, `InternalComponentController`
- Related bugfix: [BUG-067](BUG-067-internal-components-system.md) — Internal Components System Implementation (backend)
