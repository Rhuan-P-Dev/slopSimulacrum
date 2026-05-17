# BUG-069: Server Missing `worldStateController` in Express `app.locals`

| Field | Value |
|-------|-------|
| **Severity** | High |
| **Status** | Open |
| **Category** | Architectural — Server Configuration |
| **Introduced By** | Internal Components system (BUG-067) |
| **Related Code** | `src/routes/internalComponentRoutes.js`, `src/server.js`, `src/routes/index.js` |

## Problem Description

The `internalComponentRoutes.js` module accesses the `worldStateController` via `req.app.locals.worldStateController` at lines 39, 60, 78, and 107:

```javascript
// src/routes/internalComponentRoutes.js (line 39)
const worldStateController = req.app.locals.worldStateController;
if (!worldStateController) {
    return res.status(503).json({ error: 'WorldStateController not available' });
}
```

However, `src/server.js` **never sets** `app.locals.worldStateController`. The `registerRoutes()` function receives `worldStateController` as a parameter but only passes it to specific route modules (chat, world, action, capability, synergy, selection routes). The internal component routes bypass this pattern by directly accessing `req.app.locals.worldStateController`.

**Result**: All four internal component API endpoints that require `worldStateController` (GET `/:entityId/:hostComponentId`, GET `/:entityId`, POST `/:entityId/:hostComponentId/add`, DELETE `/:entityId/:hostComponentId/:internalComponentId`) will receive a `503 WorldStateController not available` response at runtime because `req.app.locals.worldStateController` is `undefined`.

## Affected Endpoints

| Endpoint | Behavior |
|----------|----------|
| `GET /api/internal-components/registry` | ✅ Works (uses `DataLoader.loadJsonSafe()`, no `worldStateController` needed) |
| `GET /api/internal-components/:entityId/:hostComponentId` | ❌ Returns 503 — `worldStateController` is `undefined` |
| `GET /api/internal-components/:entityId` | ❌ Returns 503 — `worldStateController` is `undefined` |
| `POST /api/internal-components/:entityId/:hostComponentId/add` | ❌ Returns 503 — `worldStateController` is `undefined` |
| `DELETE /api/internal-components/:entityId/:hostComponentId/:internalComponentId` | ❌ Returns 503 — `worldStateController` is `undefined` |

## Root Cause

The `internalComponentRoutes` module was registered differently from all other route modules in `src/routes/index.js`:

```javascript
// src/routes/index.js (line 26)
// Internal component routes — uses req.app.locals (BROKEN)
app.use('/api/internal-components', internalComponentRoutes);

// All other routes — receive worldStateController as parameter (CORRECT)
registerWorldRoutes(router, { worldStateController, broadcastService });
registerActionRoutes(router, { worldStateController, broadcastService });
registerCapabilityRoutes(router, { worldStateController });
registerSynergyRoutes(router, { worldStateController });
registerSelectionRoutes(router, { worldStateController });
```

All other route modules follow the pattern of receiving `worldStateController` as a constructor/registration parameter. The internal component routes were registered inline without passing the controller, and instead rely on `app.locals` which is never populated.

## Fix Options

### Option A: Set `app.locals.worldStateController` in `server.js` (Minimal Fix)

```javascript
// src/server.js — after line 14
const worldStateController = new WorldStateController();
app.locals.worldStateController = worldStateController; // ADD THIS LINE
```

**Pros**: Quickest fix, no changes to routes.
**Cons**: Violates the loose coupling principle — routes access state directly via `app.locals` instead of receiving it through parameters.

### Option B: Refactor Internal Component Routes to Match Other Route Modules (Recommended)

Update `src/routes/index.js` to pass `worldStateController` as a parameter:

```javascript
// src/routes/index.js
import { register as registerInternalComponentRoutes } from './internalComponentRoutes.js';

export function registerRoutes(app, llmController, worldStateController, broadcastService) {
    const router = express.Router();
    // ...
    registerInternalComponentRoutes(router, { worldStateController });
    // ...
}
```

Update `src/routes/internalComponentRoutes.js` to accept a configuration parameter:

```javascript
// src/routes/internalComponentRoutes.js
export function register(router, { worldStateController }) {
    const routeRouter = express.Router();
    // ... use worldStateController directly
    router.use('/api/internal-components', routeRouter);
}

export default router; // Keep default export for backward compatibility
```

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