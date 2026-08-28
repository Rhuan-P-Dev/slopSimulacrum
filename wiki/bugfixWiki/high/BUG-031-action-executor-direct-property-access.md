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

When extracting `ActionExecutor` from `App.js`, the refactored code inherited direct access patterns to `ActionManager`'s internal state instead of using public API methods. The original `App.js` had direct access to `this.actions.pendingActions` and `this.selectedComponentIds`, and that pattern was carried over into the new module without abstraction.

## Fix

`ActionExecutor` now receives everything it needs through constructor injection instead of reaching into `ActionManager` internals: an `availableActions` registry (kept in sync with the action fetch in `App.js`) supplies action data, and selection state is read through the injected `selectionController`'s public API. This keeps the module testable with simple fakes and lets `ActionManager`'s internal representation evolve independently. A related falsy-value pitfall was also corrected so that an absent or falsy range value always resolves to the default instead of propagating.

## Prevention

1. **Never access another module's internal properties** — always use public API methods.
2. **JSDoc `@typedef` interfaces** should define the public contract for each module.
3. **Code review checklist**: When extracting modules, verify all cross-module access uses public methods.

## References
- Related wiki: `wiki/subMDs/client_side_architecture.md`
- Related pattern: `wiki/subMDs/controller_patterns.md` Section 4 (State Ownership vs. Logic Coordination)
- Code quality: `wiki/code_quality_and_best_practices.md` Section 1.2 (Loose Coupling)