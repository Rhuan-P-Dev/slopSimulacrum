# BUG-085: renderRangeIndicator NaN circle radius error

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/UIManager.js` (lines 179-207)

## Symptoms

After dropping an item via the drop selector, the console shows:

```
Error: <circle> attribute r: Expected length, "NaN".
renderRangeIndicator @ UIManager.js:192
_onDropSelectorExecute @ App.js?v=2:538
```

The range indicator circle fails to render, and the error propagates to the console.

## Root Cause

`_onDropSelectorExecute()` in `App.js` calculates `dropRange` via `_resolveDropRange()`, which can return `NaN` in edge cases when the range expression regex parsing produces unexpected results. The `renderRangeIndicator()` method in `UIManager.js` did not validate the `range` parameter before passing it to `setAttribute("r", range)`, causing SVG to reject the `NaN` value.

## Fix

Added input validation guard at the top of `renderRangeIndicator()`:

```javascript
renderRangeIndicator(droid, range, color = 'red', indicatorType = 'default') {
    const entitiesLayer = this.elements.entitiesLayer;

    // Guard: prevent NaN/Infinity range values from breaking SVG
    if (typeof range !== 'number' || isNaN(range) || !isFinite(range)) {
        return;
    }
    // ... rest of method
}
```

This defensive guard prevents SVG errors from invalid range values, allowing the application to continue gracefully.

## Prevention

Always validate numeric parameters before passing them to SVG attribute setters. Use defensive guards with `isNaN()` and `isFinite()` checks for any values that originate from expression parsing or user input.

## References

- Related wiki: `wiki/subMDs/frontend/client_architecture.md`
- Related controller: `UIManager`