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

### 1. ComponentViewer.js Enhancements

- Added `🔮` (internal components) button to component cards that have internal components
- Added `_onToggleInternalComponents()` method to fetch and render internal components
- Added `_renderInternalComponentPanel()` to display internal component details
- Added `_loadInternalComponentRegistry()` to fetch type descriptions from server
- Added `_getInternalComponentDescription()` to generate human-readable descriptions
- Added `_formatInternalComponentType()` to convert camelCase to readable labels
- Added `_currentEntity` and `_currentEntityId` to store entity reference
- **Fixed**: `_onToggleInternalComponents()` now receives `entity.internalComponents` as a parameter from the button click handler, ensuring it reads from the exact same source that rendered the 🔮 button
- **Fallback**: If entity reference is not available, falls back to API fetch

### 2. New Server Endpoint

- `GET /api/internal-components/registry` — Returns internal component type definitions with descriptions
- `GET /api/internal-components/:entityId/:hostComponentId` — Returns internal components for a specific host

### 3. CSS Styles

Added styles for the new UI elements:
- `.component-internal-btn` — 🔮 button styling
- `.component-internal-container` — Container for internal component cards
- `.internal-component-detail-card` — Individual internal component card
- `.internal-component-type-badge` — Type badge styling
- `.internal-component-description` — Description text styling

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
