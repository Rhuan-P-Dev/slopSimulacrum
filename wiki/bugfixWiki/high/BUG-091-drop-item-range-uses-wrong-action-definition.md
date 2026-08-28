# BUG-091: Drop Item Range Uses Wrong Action Definition — cut.range=50 Instead of dropItem.range

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/App.js`, `public/js/ActionExecutor.js`

## Symptoms

When dropping an equipped item (e.g., knife), the drop action used `cut.range=50` instead of `dropItem.range` (a dynamic expression), making drops fail when the actual distance exceeded 50 units.

## Root Cause

The drop flow stored the equipped item's action name (`'cut'`) in pending state (`_pendingDropItem`). When the range was read, it looked up `this.availableActions[pending.actionName]`, which resolved to the cut action's range of 50 instead of the dropItem action's range expression.

This occurred because the cut action was recently changed from `self_target` to `component` targeting with `range: 50`, and that range value leaked into the drop flow through shared pending state.

The root architectural issue is that pending state carried a generic `actionName` that could be overwritten by unrelated actions. The drop flow should always read from its own action definition, not from a variable that other actions can modify.

## Fix

The drop flow now always reads the `dropItem` action definition directly at every point where range or action data is consumed, instead of resolving through the shared pending action name, and drop-related pending state carries the semantic `'dropItem'` action name rather than the source item's action name. Rationale: a dedicated operation must not depend on state that unrelated actions can overwrite — pinning the read to the dropItem definition removes the cross-action leakage at its source.

## Prevention

1. **Dedicated operations should always use their own action definition** — `executeDropItem` should always read `dropItem` action data, not depend on `pending.actionName`.
2. **Pending state should carry the semantic action name** — drop-related pending state should use `actionName: 'dropItem'` not the source item's action.
3. **Range expressions should be resolvable** — `dropItem` uses an expression that correctly resolves at runtime using the droid's stats.

## References

- Related wiki: `wiki/subMDs/architecture/attack_system.md`
- Related bug: `wiki/bugfixWiki/architectural/BUG-089-hardcoded-punch-handler-in-frontend.md`
- Related bug: `wiki/bugfixWiki/high/BUG-084-dropitem-range-ignored-actions-json.md`