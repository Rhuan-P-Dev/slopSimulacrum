# BUG-069: Server Missing `worldStateController` in Express `app.locals`

| Field | Value |
|-------|-------|
| **Severity** | High |
| **Status** | Open |
| **Category** | Architectural — Server Configuration |
| **Introduced By** | Internal Components system (BUG-067) |
| **Related Code** | `src/routes/internalComponentRoutes.js`, `src/server.js`, `src/routes/index.js` |

## Problem Description

The `internalComponentRoutes.js` module accesses the `worldStateController` via `req.app.locals.worldStateController` at lines 39, 60, 78, and 107, and responds with `503 WorldStateController not available` when it is missing. However, `src/server.js` **never sets** `app.locals.worldStateController`. The `registerRoutes()` function receives `worldStateController` as a parameter but only passes it to specific route modules (chat, world, action, capability, synergy, selection routes). The internal component routes bypass this pattern by directly accessing `req.app.locals.worldStateController`.

**Result**: All four internal component API endpoints that require `worldStateController` (GET `/:entityId/:hostComponentId`, GET `/:entityId`, POST `/:entityId/:hostComponentId/add`, DELETE `/:entityId/:hostComponentId/:internalComponentId`) will receive a `503 WorldStateController not available` response at runtime because `req.app.locals.worldStateController` is `undefined`.

## Affected Endpoints

Only the registry endpoint works (it loads data via `DataLoader.loadJsonSafe()` and needs no controller). The other four internal-component endpoints — the two lookups, the add, and the remove — all return `503 WorldStateController not available` at runtime because the `app.locals` lookup resolves to `undefined`.

## Root Cause

The `internalComponentRoutes` module was registered differently from all other route modules in `src/routes/index.js`: it is mounted directly on the app without a registration function, so its handlers fetch the controller from `req.app.locals` at request time. All other route modules receive `worldStateController` as a registration parameter. Since the server never populates `app.locals.worldStateController`, the internal component routes always see `undefined`. Why it was missed: the route still "worked" structurally (the 503 guard responded cleanly), so the failure only surfaced when clients actually used the API.

## Fix Options

### Option A: Set `app.locals.worldStateController` in `server.js` (Minimal Fix)

Populate `app.locals.worldStateController` at server startup so the route's runtime lookup succeeds.

**Pros**: Quickest fix, no changes to routes.
**Cons**: Violates the loose coupling principle — routes access state directly via `app.locals` instead of receiving it through parameters, and every route must silently depend on server-startup order.

### Option B: Refactor Internal Component Routes to Match Other Route Modules (Recommended)

Register the internal component routes through a `register(router, { worldStateController })` function like all other route modules, so the controller is injected at registration time and the route no longer needs the `app.locals` lookup at all.

**Pros**: Consistent with all other route modules, maintains loose coupling, follows the DI pattern.
**Cons**: Requires changes to both `index.js` and `internalComponentRoutes.js`.

## Impact

- **Client Impact**: The ComponentViewer's 🔮 internal component panel cannot fetch internal component data via API (lines 148-150 in `ComponentViewer.js`), rendering the feature non-functional.
- **API Documentation**: `wiki/subMDs/system_map.md` Section 4.2 documents these endpoints as functional, but they are broken.
- **Wiki Accuracy**: The wiki documents the endpoints as available but does not document this runtime failure.

## References

- Related wiki: `wiki/subMDs/internal_components.md`
- Related bug: [BUG-067](../medium/BUG-067-internal-components-system.md) — Internal Components system introduction
- Related bug: [BUG-068](../medium/BUG-068-component-viewer-missing-internal-components.md) — Component Viewer UI for Internal Components
- Code: `src/routes/internalComponentRoutes.js`, `src/server.js`, `src/routes/index.js`