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

Create or import a client-side Logger module and replace all 27 instances of `console.*` with appropriate Logger methods (`log`, `warn`, `error`). If a client-side Logger already exists in `public/utils/` or similar, import and use it. Otherwise, create a lightweight client-compatible Logger that mirrors the server-side interface.

```javascript
// Before:
console.log(`[InventoryManager] Adding item: ${itemId}`);
console.error(`[InventoryManager] Failed to fit item: ${error}`);

// After:
import { Logger } from './utils/Logger.js'; // or equivalent
Logger.log(`[InventoryManager] Adding item: ${itemId}`);
Logger.error(`[InventoryManager] Failed to fit item: ${error}`);
```

## Prevention

All new client modules should use the Logger pattern from the start. Consider adding a lint rule or pre-commit hook to detect raw `console.*` usage in client-side code.

## References

- Related wiki: `wiki/code_quality_and_best_practices.md`
- Related controller: `InventoryManager` (client-side)
