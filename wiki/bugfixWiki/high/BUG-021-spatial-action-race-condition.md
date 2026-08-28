# BUG-021: Multi-Component Spatial Action Race Condition

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `22bf5dc`
- **Related Files**: `public/js/App.js` (lines 383-406)

## Symptoms

When selecting 'dash' and choosing both droid balls (2 `droidRollingBall` components), **4 droid balls** appeared in the synergy preview instead of 2. The action was effectively executed multiple times due to a race condition in the map click handler.

## Root Cause

The map click handler in `App.js` had a race condition: the pending action was only cleared *after* the handler decided which execution path to take. When the user selected components and clicked the map:
1. The stale `pending` action could trigger `moveToTarget()` (single-component) on first click
2. Then `_executeMultiComponentSpatial()` (multi-component) on subsequent clicks
3. This caused duplicate executions — each component was "moved" multiple times

## Fix

The handler now clears the pending action *first* (so no stale trigger can survive a re-entry), captures the current selection state into local variables *before* clearing it, and then executes exactly once based on that captured snapshot. The ordering is the point of the fix: with the stale pending action already gone and the execution decision made from an immutable snapshot, repeated or re-entrant clicks can no longer re-trigger the same action.

## Prevention

When handling async user interactions, always capture state before modifying it. Clear triggers (pending actions) before state mutations to prevent stale state from triggering duplicate actions.

## References

- Related wiki: `wiki/subMDs/client_action_execution.md`
- Related controller: `ClientApp`