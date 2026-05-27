# BUG-084: dropItem Range Expression in actions.json Ignored on Client

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/ActionExecutor.js`, `public/js/App.js`, `data/actions.json`

## Symptoms

When a user tries to drop their knife (or any equipped item), the client performs a local range check BEFORE sending the action to the server. The range check uses a hardcoded formula instead of the `range` expression defined in `data/actions.json`:

```log
[ActionExecutor] Drop out of range: distance=127, range=53
```

The user's `data/actions.json` defines:
```json
"range": ":Physical.strength*2+3"
```

But the client calculates range using:
```javascript
const dropRange = AppConfig.DROP.BASE_RANGE + (strength * AppConfig.MULTIPLIERS.DROP_RANGE);
// = 3 + (strength * 2)  ← hardcoded formula
```

If the user changes the range in `actions.json` to any value (even `5000`), the client behavior does NOT change because the expression is never read.

## Root Cause

`executeDropItem()` in `ActionExecutor.js` (line 237) and `_handleEquippedItemClick()` in `App.js` (line 446) calculate drop range using hardcoded `AppConfig` values instead of resolving the `range` expression from `this.availableActions`.

The `availableActions` cache IS populated with action data (including the `range` expression) during `updateActionList()`, but `executeDropItem()` never reads from it for range calculation. In contrast, `executePunch()` correctly reads range from `availableActions` (lines 114-115).

This violates the **Data-Driven Design** principle from `wiki/code_quality_and_best_practices.md`: *"Game logic (actions, items) must be decoupled from the engine code."*

Additionally, `App.js` has TWO locations with the same bug:
1. `_handleEquippedItemClick()` — calculates drop range for preview
2. `_onDropSelectorExecute()` — calculates drop range for execution

## Fix

1. **`ActionExecutor.js`**: Added `_resolveRangeExpression(expression, strength, fallback)` helper method that parses `:Trait.stat*multiplier+offset` expressions. Modified `executeDropItem()` to read range from `this.availableActions[pending.actionName]?.range`.

2. **`App.js`**: Added `_resolveDropRange(rangeExpression, strength)` helper method. Modified both `_handleEquippedItemClick()` and `_onDropSelectorExecute()` to resolve range from `this.availableActions`.

3. **`public/js/RangeExpressionResolver.js`**: New reusable utility for client-side range expression resolution, mirroring server-side `PlaceholderResolver.js` logic.

4. **`public/js/Config.js`**: Added deprecation comments to `DROP.BASE_RANGE` and `MULTIPLIERS.DROP_RANGE` noting they are legacy fallback values.

Expression parsing follows the same pattern as server-side `PlaceholderResolver.js`:
- Parse `:Trait.stat` placeholder → resolve to stat value
- Apply optional multiplier (`*2`)
- Sum the terms

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