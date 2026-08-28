# BUG-081: `/pick-up-item` Route Directly Accesses Consequence Handler (Violates Public API Rule)

- **Severity**: HIGH
- **Status**: 🔴 Open
- **Fixed In**: `—`
- **Related Files**: `src/routes/worldRoutes.js` (lines 117-125)

## Symptoms

The `/pick-up-item` POST endpoint bypasses the public API and reaches through a sub-controller (`actionController`) into a deeply nested private handler registry to pull out the pick-up handler directly. This violates the **"No Direct Property Access"** and **"Public API Only"** rules from [project_rules.md](../../project_rules.md).

## Root Cause

The `worldRoutes.js` file accesses `worldStateController.actionController._consequenceHandlers.handlers.pickUpItem` — a deeply nested private property chain — instead of using a public method on `WorldStateController`.

According to project rules:
> **Public API Only:** Use the root controller's public methods. Never access sub-controllers directly.
> **No Direct Instantiation:** Use injected controllers for data access, never access another controller's internal state directly.

The proper pattern would be for `WorldStateController` to expose a public method like `pickUpItem(droppedItemId, componentId)` that internally invokes the consequence handler.

## Fix

Expose a public `pickUpItem(droppedItemId, componentId)` method on `WorldStateController` that internally invokes the pick-up consequence handler, and point `worldRoutes.js` at that public method. Why: the root controller is the only layer allowed to reach into the consequence handler system; the route must depend only on the public API so that internal restructuring of the handler registry can never break it again.

## Prevention

- All route handlers must use public API methods on `WorldStateController`
- Sub-controllers must NOT be accessed directly from routes or middleware
- If a new feature requires a new capability, add a public method to `WorldStateController` first

## References
- Related wiki: `wiki/project_rules.md` (Section 2: Critical Architectural Constraints)
- Related wiki: `wiki/subMDs/systems/world_map_pickup.md`
- Related controller: `WorldStateController`, `PickUpItemHandler`