# BUG-085: renderRangeIndicator NaN circle radius error

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `public/js/UIManager.js` (lines 179-207)

## Symptoms

After dropping an item via the drop selector, the console shows `Error: <circle> attribute r: Expected length, "NaN".` from `renderRangeIndicator` via `_onDropSelectorExecute`. The range indicator circle fails to render, and the error propagates to the console.

## Root Cause

`_onDropSelectorExecute()` in `App.js` calculates `dropRange` via `_resolveDropRange()`, which can return `NaN` in edge cases when the range expression regex parsing produces unexpected results. The `renderRangeIndicator()` method in `UIManager.js` did not validate the `range` parameter before passing it to `setAttribute("r", range)`, causing SVG to reject the `NaN` value.

## Fix

`renderRangeIndicator()` now starts with a defensive guard that returns early when the range value is not a finite number (NaN/Infinity/non-numeric). Why: the indicator is purely cosmetic, so an invalid range should simply suppress the ring instead of throwing an SVG attribute error that aborts the rest of the render path — the bad value is a symptom of upstream expression-parsing edge cases, and the renderer should degrade gracefully rather than become the place it surfaces.

## Prevention

Always validate numeric parameters before passing them to SVG attribute setters. Use defensive guards with `isNaN()` and `isFinite()` checks for any values that originate from expression parsing or user input.

## References

- Related wiki: `wiki/subMDs/frontend/client_architecture.md`
- Related controller: `UIManager`