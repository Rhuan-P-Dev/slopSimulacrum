# BUG-086: `/pick-up-item` Returns 500 — "PickUpItem consequence handler not registered"

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `src/routes/worldRoutes.js` (lines 129-167), `src/controllers/WorldStateController.js` (lines 943-958)

## Symptoms

When a user drops an item and attempts to pick it up via the overlay, the client receives a **500 Internal Server Error** (`[ClientErrorController] [PICKUP_FAILED] Internal Server Error`), and the server logs `ERROR: /pick-up-item endpoint error` with the context `"PickUpItem consequence handler not registered."`

## Root Cause

Two issues combined to cause this bug:

### Issue 1: Property Name Mismatch (Direct Cause)

In `src/routes/worldRoutes.js` (before fix), the route looked up the handler registry as `actionController._consequenceHandlers` (with underscore prefix), but `actionController.js` stores the registry as `consequenceHandlers` (without the `_` prefix). The lookup chain therefore resolved to `undefined`, `pickUpHandler` was undefined, and the "handler not registered" error was thrown.

### Issue 2: Architectural Violation (Underlying Cause)

Even with the correct property name, the route was directly accessing internal controller properties (`actionController._consequenceHandlers.handlers.pickUpItem`), which violates **project_rules.md** (Section 2 — Public API Only):

> **Public API Only:** Use the root controller's public methods. Never access sub-controllers directly.

This pattern is fragile and breaks encapsulation, as demonstrated by this property name mismatch bug.

## Fix

### 1. Added `executePickUpItem()` Public API Method

Added a public `executePickUpItem(entityId, droppedItemId, componentId)` method to `WorldStateController` that locates the pick-up handler internally and delegates to it, returning a structured failure if the handler is unavailable. Why: the root controller is the only layer allowed to reach into the consequence handler system, so the lookup belongs behind a public method.

### 2. Updated Route to Use Public API

`worldRoutes.js` now calls the public method instead of walking the private property chain, eliminating the direct property access and following the **Public API Only** rule.

## Prevention

1. **Routes must use WorldStateController public API methods** instead of directly accessing sub-controllers.
2. **Property names must match** — when accessing properties via the chain, ensure the correct name (with/without underscore prefix).
3. **Consider the `worldRoutes.js` pattern as a precedent** for how NOT to access consequence handlers. All future routes should use public API methods.

## References

- Related wiki: [Project Rules](../../project_rules.md) — Section 2: Public API Only
- Related wiki: [Consequence Handler Architecture](../../subMDs/controllers/consequence_handler_architecture.md)
- Related controller: `ConsequenceHandlers`, `ActionController`, `PickUpItemHandler`
- Related bug: [BUG-081](BUG-081-pickup-item-direct-consequence-handler-access.md) — Original report about direct consequence handler access in `/pick-up-item`