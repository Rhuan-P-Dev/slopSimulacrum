# BUG-027: Server Uses console.log Instead of Centralized Logger

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `4cf43abf` (audit/fix commit)
- **Related Files**: `src/server.js`

## Symptoms

`src/server.js` used direct `console.log()`, `console.warn()`, and `console.error()` calls throughout all API endpoints and Socket.io handlers instead of the centralized `Logger` utility (`src/utils/Logger.js`). This violated the logging standard defined in `wiki/map.md`:

> "All controllers must use the centralized `Logger` utility (`src/utils/Logger.js`) for structured logging with severity levels (`INFO`, `WARN`, `ERROR`, `CRITICAL`)."

Found **23 violations** across all route handlers, Socket.io connection events, and server startup.

## Root Cause

The server.js file was initially written with raw `console.*` calls for simplicity during prototyping. The `Logger` utility existed (`src/utils/Logger.js`) but was never adopted at the server entry point level. This was a consistency gap — controllers like `WorldStateController` correctly used `Logger`, but the server-level code did not.

## Fix

1. Added Logger import: `import Logger from './utils/Logger.js';`
2. Replaced all 23 `console.*` calls with appropriate `Logger.*` methods:
   - `console.log()` → `Logger.info()` with structured context objects
   - `console.warn()` → `Logger.warn()` with context
   - `console.error()` → `Logger.error()` with error details
   - `console.error('[Socket Error] ...')` → `Logger.critical()` for critical failures
3. Renamed generic variable `state` to `worldState` in `broadcastWorldState()` for semantic clarity
4. Added JSDoc `@returns {void}` and `@param` type hints where missing

### Example Changes:
```javascript
// Before
console.log(`[Socket] New connection: ${socket.id}`);

// After
Logger.info('New socket connection', { socketId: socket.id });
```

```javascript
// Before
console.error(`[Server Error] ${error.message}`);

// After
Logger.error('/execute-action endpoint error', { error: error.message, actionName, entityId });
```

## Prevention

- Enforce linting rules that disallow `console.*` in production code
- Add code review checklist item: "Verify Logger usage over console.*"
- Consider adding an ESLint rule: `no-console: error`

## References
- Related standard: `wiki/map.md` — Logging Standard
- Related wiki: `wiki/code_quality_and_best_practices.md` Section 4.1
- Logger utility: `src/utils/Logger.js`