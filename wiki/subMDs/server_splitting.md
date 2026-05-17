# Server Splitting Architecture

This wiki documents the modular server architecture where `src/server.js` was split into multiple single-responsibility modules.

## Overview

The original `src/server.js` (455 lines) was refactored following the **Single Responsibility Principle** and **Dependency Injection patterns** defined in `wiki/subMDs/controller_patterns.md`.

## Architecture Diagram

```mermaid
graph TD
    subgraph "Entry Point"
        SERVER[src/server.js - 22 lines]
    end

    subgraph "Bootstrap"
        BOOT[src/utils/serverBootstrap.js]
    end

    subgraph "Controllers"
        SOCKET[src/controllers/SocketLifecycleController.js]
    end

    subgraph "Services"
        BROADCAST[src/services/WorldStateBroadcastService.js]
    end

    subgraph "Routes"
        ROUTES[src/routes/index.js]
        CHAT[src/routes/chatRoutes.js]
        WORLD[src/routes/worldRoutes.js]
        ACTION[src/routes/actionRoutes.js]
        CAP[src/routes/capabilityRoutes.js]
        SYNERGY[src/routes/synergyRoutes.js]
        SELECT[src/routes/selectionRoutes.js]
        ICOMP[src/routes/internalComponentRoutes.js]
    end

    SERVER --> BOOT
    SERVER --> SOCKET
    SERVER --> BROADCAST
    SERVER --> ROUTES
    ROUTES --> CHAT
    ROUTES --> WORLD
    ROUTES --> ACTION
    ROUTES --> CAP
    ROUTES --> SYNERGY
    ROUTES --> SELECT
    ROUTES --> ICOMP
```

## File Structure

| File | Lines | Responsibility |
|------|-------|----------------|
| `src/server.js` | ~22 | Minimal entry point, controller initialization |
| `src/utils/serverBootstrap.js` | ~25 | Express app, HTTP server, Socket.IO setup |
| `src/controllers/SocketLifecycleController.js` | ~95 | Socket connection, incarnation, disconnect, error handling |
| `src/services/WorldStateBroadcastService.js` | ~35 | Broadcasting world state to clients |
| `src/routes/index.js` | ~20 | Router composition, route registration |
| `src/routes/chatRoutes.js` | ~30 | POST /chat |
| `src/routes/worldRoutes.js` | ~75 | GET /world-state, GET /rooms, POST /move-entity |
| `src/routes/actionRoutes.js` | ~85 | GET /actions, POST /execute-action |
| `src/routes/capabilityRoutes.js` | ~105 | GET/POST /action-capabilities/*, POST /refresh-entity-capabilities |
| `src/routes/synergyRoutes.js` | ~110 | GET/POST /synergy/* |
| `src/routes/selectionRoutes.js` | ~120 | GET/POST /select-component*, POST /release-selection, GET /selections/* |
| `src/routes/internalComponentRoutes.js` | ~127 | GET /api/internal-components/*, POST /api/internal-components/:entityId/:hostComponentId/add, DELETE /api/internal-components/:entityId/:hostComponentId/:internalComponentId |

## Route Dependencies

| Route File | Dependencies |
|------------|-------------|
| `chatRoutes.js` | `llmController` |
| `worldRoutes.js` | `worldStateController`, `broadcastService` |
| `actionRoutes.js` | `worldStateController`, `broadcastService` |
| `capabilityRoutes.js` | `worldStateController` |
| `synergyRoutes.js` | `worldStateController` |
| `selectionRoutes.js` | `worldStateController` |
| `internalComponentRoutes.js` | `worldStateController` (via `req.app.locals`) |

## Route Registration Pattern

Each route file exports a `register(router, deps)` function:

```javascript
export function register(router, { worldStateController, broadcastService }) {
    router.get('/path', (req, res) => { ... });
    router.post('/path', (req, res) => { ... });
}
```

The index file composes all routes:

```javascript
export function registerRoutes(app, llmController, worldStateController, broadcastService) {
    const router = express.Router();
    registerChatRoutes(router, { llmController });
    registerWorldRoutes(router, { worldStateController, broadcastService });
    // ... etc
    app.use('/', router);
}
```

### Internal Component Routes Module Pattern

The `internalComponentRoutes.js` module uses a slightly different registration pattern — it exports the Express Router directly rather than using a `register()` function:

```javascript
// In src/routes/internalComponentRoutes.js:
import express from 'express';
const router = express.Router();

// Route handlers use req.app.locals.worldStateController
router.get('/registry', (req, res) => { ... });
router.get('/:entityId', (req, res) => { ... });
router.get('/:entityId/:hostComponentId', (req, res) => { ... });
router.post('/:entityId/:hostComponentId/add', (req, res) => { ... });
router.delete('/:entityId/:hostComponentId/:internalComponentId', (req, res) => { ... });

export default router;
```

**Mounting in `src/server.js`:**
```javascript
import internalComponentRoutes from './routes/internalComponentRoutes.js';
app.use('/api/internal-components', internalComponentRoutes);
```

This pattern is used for standalone route modules that don't need dependency injection — they access `worldStateController` via `req.app.locals` instead of constructor parameters.

## Quality Standards Compliance

- **SRP**: Each module has exactly one reason to change
- **DI Pattern**: All dependencies injected via constructor (controllers) or function parameters (routes)
- **Logger**: All modules use centralized `Logger` utility (`src/utils/Logger.js`)
- **Public API**: All routes use `WorldStateController` public methods only
- **Error Handling**: Consistent try/catch + Logger.error pattern across all endpoints
- **Input Validation**: All POST endpoints validate required fields before processing

## Recent Changes

| Date | Change | Related Files |
|------|--------|---------------|
| 2026-05-15 | **Feature:** Added internal components REST API — `internalComponentRoutes.js` with 5 endpoints, route registration in `index.js`, `worldStateController` dependency | `src/routes/internalComponentRoutes.js`, `src/routes/index.js` |

## References

- [Controller Patterns](controller_patterns.md)
- [Server-Client Architecture](server_client_architecture.md)
- [Code Quality and Best Practices](../code_quality_and_best_practices.md)
