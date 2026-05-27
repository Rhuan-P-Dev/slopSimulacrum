# BUG-086: `/pick-up-item` Returns 500 — "PickUpItem consequence handler not registered"

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/routes/worldRoutes.js` (lines 129-167), `src/controllers/WorldStateController.js` (lines 943-958)

## Symptoms

When a user drops an item and attempts to pick it up via the overlay, the client receives a **500 Internal Server Error**:

```
POST http://localhost:3000/pick-up-item 500 (Internal Server Error)
[ClientErrorController] [PICKUP_FAILED] Internal Server Error
```

Server-side error log:
```
ERROR: /pick-up-item endpoint error | Context: {"error":"PickUpItem consequence handler not registered.","entityId":"03ed4e16-2aa0-4972-9ee8-25d055875c7f","droppedItemId":"dropped-1779922321643-item-14","componentId":"ef27614e-4379-4d04-9b44-19821031b928"}
```

## Root Cause

Two issues combined to cause this bug:

### Issue 1: Property Name Mismatch (Direct Cause)

In `src/routes/worldRoutes.js` (before fix), line 140 accessed a **non-existent** internal property:

```javascript
// BEFORE (broken):
const consequenceHandlers = worldStateController.actionController._consequenceHandlers;
//                                         ^^^^^^^^^^^^^^^^^^
//                                         Wrong! Property is "consequenceHandlers" (no underscore)
```

In `src/controllers/actions/actionController.js` (line 72), the property is stored as `this.consequenceHandlers` (without the `_` prefix). This caused the lookup chain to resolve to `undefined`, making `pickUpHandler` undefined, and the error was thrown.

### Issue 2: Architectural Violation (Underlying Cause)

Even with the correct property name, the route was directly accessing internal controller properties (`actionController._consequenceHandlers.handlers.pickUpItem`), which violates **project_rules.md** (Section 2 — Public API Only):

> **Public API Only:** Use the root controller's public methods. Never access sub-controllers directly.

This pattern is fragile and breaks encapsulation, as demonstrated by this property name mismatch bug.

## Fix

### 1. Added `executePickUpItem()` Public API Method

Added a new public method to `WorldStateController` (`src/controllers/WorldStateController.js`):

```javascript
/**
 * Picks up a dropped item from the map and adds it to an entity's inventory component.
 * This is the public API for the pick-up-item operation, delegating to the consequence handler system.
 */
executePickUpItem(entityId, droppedItemId, componentId) {
    const pickUpHandler = this.actionController?.consequenceHandlers?.handlers?.pickUpItem;

    if (typeof pickUpHandler !== 'function') {
        Logger.error('[WorldStateController] PickUpItem handler not available.');
        return { success: false, message: 'PickUpItem handler not available.' };
    }

    return pickUpHandler(null, { entityId, droppedItemId, componentId }, { entityId });
}
```

### 2. Updated Route to Use Public API

Changed `src/routes/worldRoutes.js` to call the public API method:

```javascript
// AFTER (fixed):
const result = worldStateController.executePickUpItem(entityId, droppedItemId, componentId);
```

This eliminates the direct property access and follows the **Public API Only** rule.

## Prevention

1. **Routes must use WorldStateController public API methods** instead of directly accessing sub-controllers.
2. **Property names must match** — when accessing properties via the chain, ensure the correct name (with/without underscore prefix).
3. **Consider the `worldRoutes.js` pattern as a precedent** for how NOT to access consequence handlers. All future routes should use public API methods.

## References

- Related wiki: [Project Rules](../../project_rules.md) — Section 2: Public API Only
- Related wiki: [Consequence Handler Architecture](../../subMDs/controllers/consequence_handler_architecture.md)
- Related controller: `ConsequenceHandlers`, `ActionController`, `PickUpItemHandler`
- Related bug: [BUG-081](BUG-081-pickup-item-direct-consequence-handler-access.md) — Original report about direct consequence handler access in `/pick-up-item`