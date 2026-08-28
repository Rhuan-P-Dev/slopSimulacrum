# BUG-020: deltaSpatial Speed Property Rendering

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `22bf5dc`
- **Related Files**: `public/js/UIManager.js` (lines 425-437, 492-500)

## Symptoms

In the synergy preview "Modified Values:" section, `deltaSpatial` values did not appear — the `deltaSpatial` consequence was silently skipped while stat-delta consequences rendered normally.

## Root Cause

The `UIManager._buildSynergyPreviewHtml()` method determined whether to display a consequence by checking for a numeric `value` property. However, `deltaSpatial` resolved values carry their number in a `speed` property (e.g., `{ "speed": 20 }`) instead of `value`, so `baseResolved.value` was `undefined` and the consequence was skipped entirely.

## Fix

The preview builders (`_buildActionDataHtml()` and `_buildSynergyPreviewHtml()`) now recognize `deltaSpatial`'s `speed` property alongside the generic `value` property, so spatial deltas are rendered instead of silently dropped.

## Prevention

When adding new consequence types, document their property structure in `wiki/subMDs/synergy_preview.md` and ensure the frontend handles all consequence property formats.

## References

- Related wiki: `wiki/subMDs/synergy_preview.md`
- Related controller: `UIManager`