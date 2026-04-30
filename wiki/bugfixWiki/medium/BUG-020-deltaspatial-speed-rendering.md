# BUG-020: deltaSpatial Speed Property Rendering

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `22bf5dc`
- **Related Files**: `public/js/UIManager.js` (lines 425-437, 492-500)

## Symptoms

In the synergy preview "Modified Values:" section, `deltaSpatial` values did not appear:

```
⚡ Synergy: 1.500x (+50%)
Modified Values:
  (deltaSpatial missing!)
🔻 updateComponentStatDelta (value): 5 → 9.8 (+95%)
```

The `deltaSpatial` consequence was silently skipped.

## Root Cause

The `UIManager._buildSynergyPreviewHtml()` method checked `typeof baseResolved.value !== 'number'` to determine if a consequence should be displayed. However, `deltaSpatial` resolved values use a `speed` property (e.g., `{ "speed": 20 }`) instead of `value`:

```javascript
// Broken: { speed: 20 } has no .value property
if (!baseResolved || typeof baseResolved.value !== 'number') continue;
```

Since `baseResolved.value` was `undefined`, the consequence was skipped entirely.

## Fix

Added special handling for `deltaSpatial` in both `_buildActionDataHtml()` and `_buildSynergyPreviewHtml()`:

```javascript
// UIManager.js - _buildSynergyPreviewHtml
let baseValue;
if (consequence.type === 'deltaSpatial') {
    if (!baseResolved || typeof baseResolved.speed !== 'number') continue;
    baseValue = baseResolved.speed;
} else {
    if (!baseResolved || typeof baseResolved.value !== 'number') continue;
    baseValue = baseResolved.value;
}
```

## Prevention

When adding new consequence types, document their property structure in `wiki/subMDs/synergy_preview.md` and ensure the frontend handles all consequence property formats.

## References

- Related wiki: `wiki/subMDs/synergy_preview.md`
- Related controller: `UIManager`