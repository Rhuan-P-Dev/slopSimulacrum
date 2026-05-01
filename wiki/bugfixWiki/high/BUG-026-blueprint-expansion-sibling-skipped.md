# BUG-026: Blueprint Expansion Skips Sibling Components

**Status:** ✅ Fixed
**Severity:** Critical
**Date Fixed:** 2026-04-30

## Problem

When a client incarnated entity (using `smallBallDroid` → `centralBall` blueprint) was spawned, the **right arm** components (`droidArm`, `droidHand`, `humanoidDroidFinger`) were not being created. Only the left arm components existed.

## Root Cause

The `expandBlueprint()` method in `src/controllers/entityController.js` used a **shared `visited` Set** across all recursive expansion branches. When `centralBall` blueprint expands both `["droidArm", "left"]` and `["droidArm", "right"]`:

1. Left arm expands `droidArm` → adds `"droidArm"` to `visited`
2. Right arm tries to expand `droidArm` → **line 28 checks `visited.has("droidArm")` → returns `[]` empty array!**

This meant the right arm's children (`droidHand`, `humanoidDroidFinger`) were **never expanded** because the `visited` Set prevented re-expanding a blueprint that was already visited in a **sibling** branch.

## Blueprint Chain
```
smallBallDroid → ["centralBall"]
centralBall → ["droidHead", ["droidArm", "left"], ["droidArm", "right"], ...]
droidArm → ["droidHand"]
droidHand → ["humanoidDroidFinger", "left/middle/right"]
```

## Fix

Changed `expandBlueprint()` to use a **per-branch `visited` Set** so sibling blueprints can be expanded independently:

```javascript
// Before (buggy):
if (this.blueprints[compName]) {
    components.push(...this.expandBlueprint(compName, visited).map(c => ...));
}

// After (fixed):
if (this.blueprints[compName]) {
    const branchVisited = new Set(visited);
    branchVisited.add(blueprintName);
    components.push(...this.expandBlueprint(compName, branchVisited).map(c => ...));
}
```

## Files Modified
- `src/controllers/entityController.js` — `expandBlueprint()` method (lines 48-67)

## Impact
- All entities using multi-component blueprints with sibling components now correctly spawn
- `droidArm` (left/right), `droidRollingBall` (left/right), `humanoidDroidFinger` (left/middle/right) all expand properly