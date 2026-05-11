# BUG-054: ConfigBarManager Calls Non-Existent Action Endpoint

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/ConfigBarManager.js` (lines 118-129)

## Symptoms

When clicking the 👍 Navigation & Actions button in the config bar, the browser console shows repeated 404 errors:

```
GET http://localhost:3000/api/world/actions/19ab90ff-8b9d-405a-83b4-1dddb92d75f8 404 (Not Found)
```

The NavActionsPanel still renders (with empty actions as fallback), but the action list is never populated from the server.

## Root Cause

`ConfigBarManager._fetchActionsForPanel()` constructed an incorrect URL using a path-based pattern with an `/api/` prefix:

```javascript
// ❌ WRONG: No server route matches this pattern
const response = await fetch(`/api/world/actions/${entityId}`);
```

The server has no route at `/api/world/actions/:entityId`. The correct endpoint is defined in `src/routes/actionRoutes.js`:

```javascript
router.get('/actions', (req, res) => {
    const { entityId } = req.query;
    // ...
});
```

Additionally, the response format was not parsed correctly — the server returns `{ actions: {...} }`, but the code returned `response.json()` directly without extracting the `actions` property.

## Fix

**File:** `public/js/ConfigBarManager.js` — `_fetchActionsForPanel()` method

```javascript
// ✅ FIXED: Use query parameter pattern matching ActionManager
const response = await fetch(`/actions?entityId=${entityId}`);
if (!response.ok) return {};
const data = await response.json();
return data.actions || {};
```

### Changes Made
| Line | Before | After |
|------|--------|-------|
| 123 | `` `/api/world/actions/${entityId}` `` | `` `/actions?entityId=${entityId}` `` |
| 125 | `return await response.json();` | `const data = await response.json(); return data.actions || {};` |

## Prevention

1. **Centralize endpoint definitions** — Move all API endpoint URLs to `Config.js` `ENDPOINTS` section (like `ActionManager` does) rather than hardcoding URLs in individual managers.
2. **Consistent URL patterns** — All client modules should use the same pattern (query parameters for filters, no `/api/` prefix).
3. **Network error monitoring** — Add automated tests that verify all fetch URLs resolve without 404s.

## References
- Related wiki: `wiki/subMDs/client_ui.md`
- Related manager: `ConfigBarManager`, `NavActionsPanel`, `ActionManager`
- Server route: `src/routes/actionRoutes.js`