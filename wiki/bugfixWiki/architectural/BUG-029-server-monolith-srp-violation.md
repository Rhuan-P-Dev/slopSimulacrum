# BUG-029: Server Monolith Violates Single Responsibility Principle

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `pending` (server splitting refactoring)
- **Related Files**: `src/server.js` (455 lines → 22 lines), new modules created

## Symptoms

`src/server.js` combined 5 distinct responsibilities in a single 455-line file:
1. Server setup (Express, HTTP, Socket.IO, middleware)
2. Controller initialization (LLMController, WorldStateController)
3. World state broadcasting logic
4. Socket lifecycle management (incarnation, disconnect, error handling)
5. HTTP REST API endpoints (20+ route handlers)

## Root Cause

The server file grew organically over time as new endpoints and features were added without modularizing the code. This violated the Single Responsibility Principle defined in `wiki/code_quality_and_best_practices.md` Section 1.1.

## Fix

Split `src/server.js` into 11 focused modules:

| File | Responsibility | Lines |
|------|----------------|-------|
| `src/server.js` | Minimal entry point, controller initialization | ~22 |
| `src/utils/serverBootstrap.js` | Express app, HTTP server, Socket.IO setup | ~25 |
| `src/controllers/SocketLifecycleController.js` | Socket connection/incarnation/disconnect/error | ~95 |
| `src/services/WorldStateBroadcastService.js` | Broadcasting world state to clients | ~35 |
| `src/routes/index.js` | Router composition, route registration | ~20 |
| `src/routes/chatRoutes.js` | POST /chat | ~30 |
| `src/routes/worldRoutes.js` | GET /world-state, GET /rooms, POST /move-entity | ~75 |
| `src/routes/actionRoutes.js` | GET /actions, POST /execute-action | ~85 |
| `src/routes/capabilityRoutes.js` | Action capabilities endpoints | ~105 |
| `src/routes/synergyRoutes.js` | Synergy endpoints | ~110 |
| `src/routes/selectionRoutes.js` | Component selection endpoints | ~120 |

All modules follow:
- **DI Pattern**: Dependencies injected via constructor or function parameters
- **Logger**: Centralized Logger utility for structured logging
- **Public API**: WorldStateController public methods only
- **Error Handling**: Consistent try/catch + Logger.error pattern
- **Input Validation**: All POST endpoints validate required fields

## Prevention

When adding new endpoints or server features:
1. Identify if the feature has a distinct responsibility
2. If yes, create a new module following the established pattern
3. Never add logic directly to `src/server.js` beyond controller initialization
4. Route handlers belong in `src/routes/`, not in the entry point

## References
- [Server Splitting Architecture](../../../subMDs/server_splitting.md)
- [Controller Patterns](../../../subMDs/controller_patterns.md)
- [Code Quality and Best Practices](../../../code_quality_and_best_practices.md)