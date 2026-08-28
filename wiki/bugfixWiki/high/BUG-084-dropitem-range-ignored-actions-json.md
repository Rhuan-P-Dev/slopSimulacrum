# BUG-084: dropItem Range Expression in actions.json Ignored on Client

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/ActionExecutor.js`, `public/js/App.js`, `data/actions.json`

## Symptoms

When a user tries to drop their knife (or any equipped item), the client performs a local range check BEFORE sending the action to the server, and fails with `[ActionExecutor] Drop out of range: distance=127, range=53`. The check uses a hardcoded formula instead of the `range` expression defined in `data/actions.json` — if the expression is changed to any value (even `5000`), the client behavior does NOT change because the expression is never read.

## Root Cause

`executeDropItem()` in `ActionExecutor.js` (line 237) and `_handleEquippedItemClick()` in `App.js` (line 446) calculate drop range using hardcoded `AppConfig` values instead of resolving the `range` expression from `this.availableActions`.

The `availableActions` cache IS populated with action data (including the `range` expression) during `updateActionList()`, but `executeDropItem()` never reads from it for range calculation. In contrast, `executePunch()` correctly reads range from `availableActions` (lines 114-115).

This violates the **Data-Driven Design** principle from `wiki/code_quality_and_best_practices.md`: *"Game logic (actions, items) must be decoupled from the engine code."*

Additionally, `App.js` has TWO locations with the same bug:
1. `_handleEquippedItemClick()` — calculates drop range for preview
2. `_onDropSelectorExecute()` — calculates drop range for execution

## Fix

All client-side drop range checks now resolve the `range` expression from the `availableActions` cache instead of computing a hardcoded formula, using a shared client-side `RangeExpressionResolver` utility that mirrors the server-side placeholder resolution. The old `AppConfig` constants remain only as deprecated fallback values. Why: `data/actions.json` is the single source of truth for action ranges — hardcoding the formula on the client violated data-driven design and meant data edits could never change client behavior; resolving the expression (instead of re-implementing the math) keeps client and server interpretations of the same expression consistent.

## Prevention

- All range-based actions must read range from `availableActions` cache, not hardcoded values
- Expression parsing must mirror the server's `PlaceholderResolver.js` logic
- Range expressions in `data/actions.json` are the single source of truth
- Add client-side tests that verify range resolution matches actions.json

## References
- Related wiki: `wiki/code_quality_and_best_practices.md` (Data-Driven Design section)
- Related wiki: `wiki/project_rules.md` (SRP and loose coupling)
- Related controller: `ActionExecutor`, `ClientApp`
- Similar pattern: `executePunch()` already correctly uses `availableActions` pattern