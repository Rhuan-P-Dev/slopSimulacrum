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

All 23 `console.*` calls in `src/server.js` were replaced with the centralized `Logger` at appropriate severity levels (log → info, warn → warn, error → error, critical failures → critical), with structured context objects so log entries carry the details needed for diagnosis. The entry point was also tidied for consistency: the generic `state` variable in `broadcastWorldState()` was renamed `worldState`, and missing JSDoc type hints were added.

## Prevention

- Enforce linting rules that disallow `console.*` in production code
- Add code review checklist item: "Verify Logger usage over console.*"
- Consider adding an ESLint rule: `no-console: error`

## References
- Related standard: `wiki/map.md` — Logging Standard
- Related wiki: `wiki/code_quality_and_best_practices.md` Section 4.1
- Logger utility: `src/utils/Logger.js`