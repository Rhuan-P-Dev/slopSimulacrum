# BUG-019: Action Preview Name Missing (`_name` property)

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `22bf5dc`
- **Related Files**: `src/controllers/actionController.js` (line 1219), `public/js/UIManager.js` (line 410)

## Symptoms

In the action preview panel (synergy preview), the action name displayed as:
```
📋 Action: Unknown
```
Instead of the actual action name (e.g., "dash", "move", "droid punch").

## Root Cause

The `ActionController.previewActionData()` method returned `actionDef` directly from the action registry without adding a `_name` property. The frontend `UIManager._buildActionDataHtml()` tried to access `actionData._name`, which was `undefined`, causing the fallback to `'Unknown'`.

```javascript
// Broken: actionData._name is undefined
html += `📋 Action: ${actionData._name || 'Unknown'}`;
```

## Fix

Added `_name: actionName` to the returned action object in `previewActionData()`:

```javascript
// actionController.js line 1219
return {
    actionData: { ...actionDef, _name: actionName },  // Added _name
    resolvedValues,
    synergyResult
};
```

## Prevention

When extending the preview API, ensure all UI-consumed properties are included in the returned object. Document expected property names in the wiki.

## References

- Related wiki: `wiki/subMDs/synergy_preview.md`
- Related controller: `ActionController`