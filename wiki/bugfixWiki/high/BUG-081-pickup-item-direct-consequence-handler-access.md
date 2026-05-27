# BUG-081: `/pick-up-item` Route Directly Accesses Consequence Handler (Violates Public API Rule)

- **Severity**: HIGH
- **Status**: 🔴 Open
- **Fixed In**: `—`
- **Related Files**: `src/routes/worldRoutes.js` (lines 117-125)

## Symptoms

The `/pick-up-item` POST endpoint bypasses the public API and directly accesses internal controller properties:

```javascript
// worldRoutes.js lines 117-118
const consequenceHandlers = worldStateController.actionController._consequenceHandlers;
const pickUpHandler = consequenceHandlers?.handlers?.pickUpItem;
```

This violates the **"No Direct Property Access"** and **"Public API Only"** rules from [project_rules.md](../../project_rules.md).

## Root Cause

The `worldRoutes.js` file accesses `worldStateController.actionController._consequenceHandlers.handlers.pickUpItem` — a deeply nested private property chain — instead of using a public method on `WorldStateController`.

According to project rules:
> **Public API Only:** Use the root controller's public methods. Never access sub-controllers directly.
> **No Direct Instantiation:** Use injected controllers for data access, never access another controller's internal state directly.

The proper pattern would be for `WorldStateController` to expose a public method like `pickUpItem(droppedItemId, componentId)` that internally invokes the consequence handler.

## Fix

Add a public method to `WorldStateController`:

```javascript
// In WorldStateController.js
pickUpItem(droppedItemId, componentId) {
    const { actionController } = this;
    const pickUpHandler = actionController?._consequenceHandlers?.handlers?.pickUpItem;
    if (typeof pickUpHandler === 'function') {
        return pickUpHandler(null, { droppedItemId, componentId }, { entityId: this._myEntityId });
    }
    throw new Error('PickUpItem handler not available.');
}
```

Then update `worldRoutes.js`:

```javascript
// In worldRoutes.js
const result = worldStateController.pickUpItem(droppedItemId, componentId);
```

## Prevention

- All route handlers must use public API methods on `WorldStateController`
- Sub-controllers must NOT be accessed directly from routes or middleware
- If a new feature requires a new capability, add a public method to `WorldStateController` first

## References
- Related wiki: `wiki/project_rules.md` (Section 2: Critical Architectural Constraints)
- Related wiki: `wiki/subMDs/systems/world_map_pickup.md`
- Related controller: `WorldStateController`, `PickUpItemHandler`