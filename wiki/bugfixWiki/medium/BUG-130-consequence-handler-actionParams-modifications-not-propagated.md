# BUG-130: Consequence Handler actionParams Modifications Not Propagated to Subsequent Consequences

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `t1-weapon-implementation`
- **Related Files**: [`src/controllers/consequences/ConsequenceDispatcher.js`](src/controllers/consequences/ConsequenceDispatcher.js) (execute method)

## Symptoms

When using the `shootT1` action, the `consumeItemAndDamage` consequence handler set `context.actionParams.itemVolume` to the consumed ammo's volume, but the subsequent `log` consequence could not resolve `:itemVolume`, producing the warning:

```
[WARN] [PlaceholderResolver] Placeholder "itemVolume" not found in resolution context.
```

The log consequence output contained `:itemVolume` as a literal string instead of the resolved numeric value.

## Root Cause

The [`ConsequenceDispatcher.execute()`](src/controllers/consequences/ConsequenceDispatcher.js) method creates a `handlerContext` for each consequence handler by spreading the original `context` object with a new `actionParams` object:

```javascript
const handlerContext = {
  ...context,
  actionParams: { ...context.actionParams }
};
```

When a handler (e.g., `consumeItemAndDamage`) modified `handlerContext.actionParams.itemVolume`, those changes were never propagated back to the original `context.actionParams`. Subsequent consequences received a fresh `handlerContext` spread from the unmodified `context`, which lacked the handler's modifications.

This meant inter-handler data passing via `actionParams` was one-directional at best — only the initial values from `actions.json` were available, not dynamically set values from prior handlers.

## Fix

Added `Object.assign(context.actionParams, handlerContext.actionParams)` after each handler call in [`ConsequenceDispatcher.execute()`](src/controllers/consequences/ConsequenceDispatcher.js) to propagate any modifications back to the shared context:

```javascript
// After each handler invocation:
Object.assign(context.actionParams, handlerContext.actionParams);
```

This ensures that any changes made by one handler to `actionParams` are visible to all subsequent handlers in the chain.

## Prevention

When designing consequence handlers that need to pass data to subsequent consequences, always modify `handlerContext.actionParams` and ensure the dispatcher propagates changes back to the original context.

If a handler needs to pass data between consequences, prefer `actionParams` over modifying other context properties, as the propagation step specifically handles `actionParams`.

## References

- Related wiki: `wiki/subMDs/systems/t1_weapon_system.md`
- Related wiki: `wiki/subMDs/controllers/consequence_handler_architecture.md`
- Related controller: `ConsequenceDispatcher`
- Related bug: `wiki/bugfixWiki/medium/BUG-124-checkItemFit-missing-container-volume.md`
