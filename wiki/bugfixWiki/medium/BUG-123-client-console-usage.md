# BUG-123: Client-Side InventoryManager Uses console.* Instead of Logger

- **Severity**: MEDIUM
- **Status**: 🔴 Open
- **Fixed In**: —
- **Related Files**: [`public/js/InventoryManager.js`](public/js/InventoryManager.js) (27 instances)

## Symptoms

The client-side InventoryManager uses `console.log`, `console.warn`, and `console.error` in 27 locations instead of a centralized Logger. This violates the project's centralized logging standard and makes it difficult to filter, route, or disable client-side logs consistently.

## Root Cause

The client-side code predates the centralized logging pattern or was not updated when the Logger utility was created. The server-side code uses `src/utils/Logger.js` consistently, but the client-side InventoryManager was written with raw `console.*` calls.

## Fix

The intended fix is to route all InventoryManager output through a client-side Logger module — reusing an existing client logging utility if one is present, or adding a lightweight client-compatible module that mirrors the server-side interface — so client-side logs can be filtered, routed, and disabled consistently with the centralized logging standard.

## Prevention

All new client modules should use the Logger pattern from the start. Consider adding a lint rule or pre-commit hook to detect raw `console.*` usage in client-side code.

## References

- Related wiki: `wiki/code_quality_and_best_practices.md`
- Related controller: `InventoryManager` (client-side)
