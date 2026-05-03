# BUG-031: ActionExecutor Direct Internal Property Access on ActionManager

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/ActionExecutor.js` (lines 111, 144, 148, 174, 221, 249)

## Symptoms

The `ActionExecutor` module directly accesses internal properties of `ActionManager`:
- `this.actions.pendingActions` — internal state of ActionManager
- `this.actions.selectedComponentIds` — internal Set state of ActionManager

This violates the **loose coupling** principle defined in `wiki/code_quality_and_best_practices.md` Section 1.2:
> "Controllers must not access the internal state (private variables) of other controllers. Communication must be handled via Interfaces or Public Methods (APIs)."

## Root Cause

When extracting `ActionExecutor` from `App.js`, the refactored code inherited direct access patterns to `ActionManager`'s internal state instead of using public API methods. The original `App.js` had direct access to `this.actions.pendingActions` and `this.selectedComponentIds`, and this pattern was carried over without abstraction.

**Affected locations in `ActionExecutor.js`:**
| Line | Property Accessed | Issue |
|------|-------------------|-------|
| 111 | `this.actions.pendingActions?.[pending.actionName]` | Accesses internal pending actions registry |
| 144 | `this.actions.selectedComponentIds` | Accesses internal Set of selected component IDs |
| 148 | `this.actions.selectedComponentIds?.clear()` | Modifies internal Set |
| 174 | `this.actions.pendingActions?.[pending.actionName]` | Accesses internal pending actions registry |
| 221 | `this.actions.selectedComponentIds?.clear()` | Modifies internal Set |
| 249 | `this.actions.pendingActions?.[pending.actionName]` | Accesses internal pending actions registry |

## Fix

Pass `availableActions` and `selectionController` via constructor injection to `ActionExecutor`:

**1. Update `ActionExecutor` constructor to accept `selectionController` and `availableActions`:**
```javascript
constructor(worldState, actions, ui, errorController, refreshCallback, selectionController, availableActions) {
    this.selectionController = selectionController;
    this.availableActions = availableActions || {};
}
```

**2. Replace direct property access in `ActionExecutor.js`:**
```javascript
// OLD: const actionData = this.actions.pendingActions?.[pending.actionName] || {};
// NEW: const actionData = this.availableActions[pending.actionName] || {};

// OLD: const handCompId = Array.from(this.actions.selectedComponentIds || [])[0]
// NEW: const handCompId = this.selectionController ? this.selectionController.getSelectedComponentIdsArray()[0] : []
```

**3. Fix range fallback from `??` to `||` to handle falsy `0` values:**
```javascript
// OLD: const range = actionData?.range ?? 100;
// NEW: const range = actionData?.range || 100;
```

**4. Sync availableActions in App.js after fetch:**
```javascript
this.availableActions = await this.actions.fetchActions(entityId);
this.executor.availableActions = this.availableActions;
```

## Prevention

1. **Never access another module's internal properties** — always use public API methods.
2. **JSDoc `@typedef` interfaces** should define the public contract for each module.
3. **Code review checklist**: When extracting modules, verify all cross-module access uses public methods.

## References
- Related wiki: `wiki/subMDs/client_side_architecture.md`
- Related pattern: `wiki/subMDs/controller_patterns.md` Section 4 (State Ownership vs. Logic Coordination)
- Code quality: `wiki/code_quality_and_best_practices.md` Section 1.2 (Loose Coupling)