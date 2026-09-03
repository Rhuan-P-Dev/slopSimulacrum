# BUG-054: ConfigBarManager Calls Non-Existent Action Endpoint

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `public/js/ConfigBarManager.js` (lines 118-129)

## Symptoms

When clicking the 👍 Navigation & Actions button in the config bar, the browser console shows repeated 404 errors on a path-based `/api/world/actions/<entityId>` URL. The NavActionsPanel still renders (with empty actions as fallback), but the action list is never populated from the server.

## Root Cause

`ConfigBarManager._fetchActionsForPanel()` constructed an incorrect URL: a path-based pattern with an `/api/` prefix for which the server has no route — the actual actions endpoint in `src/routes/actionRoutes.js` takes the entity ID as a query parameter. Additionally, the response format was not parsed correctly: the server returns an object wrapping the action list in an `actions` property, but the code used the whole JSON response directly.

## Fix

`_fetchActionsForPanel()` now targets the same actions endpoint the rest of the client uses (entity ID as a query parameter, no `/api/` prefix) and extracts the `actions` property from the response, so the NavActionsPanel is populated from the server.

## Prevention

1. **Centralize endpoint definitions** — Move all API endpoint URLs to `Config.js` `ENDPOINTS` section (like `ActionManager` does) rather than hardcoding URLs in individual managers.
2. **Consistent URL patterns** — All client modules should use the same pattern (query parameters for filters, no `/api/` prefix).
3. **Network error monitoring** — Add automated tests that verify all fetch URLs resolve without 404s.

## References
- Related wiki: `wiki/subMDs/client_ui.md`
- Related manager: `ConfigBarManager`, `NavActionsPanel`, `ActionManager`
- Server route: `src/routes/actionRoutes.js`