# BUG-122: executePickUpItem Direct Access to Private Controller Properties

- **Severity**: HIGH
- **Status**: 🔴 Open
- **Fixed In**: —
- **Related Files**: [`src/controllers/WorldStateController.js`](src/controllers/WorldStateController.js) (line 1142)

## Symptoms

`executePickUpItem()` accesses deeply nested private properties of another controller: `this.actionController?.consequenceHandlers?.handlers?.pickUpItem`. This violates the "Public API Only" rule from [`project_rules.md`](wiki/project_rules.md).

## Root Cause

The WorldStateController should use a public method on `actionController` or `consequenceHandlers` instead of directly accessing nested private properties. The current implementation bypasses the encapsulation boundary between controllers.

## Fix

Replace the direct nested private access with a proper public method call on `actionController` (or a dedicated public pick-up execution method), keeping cross-controller interactions inside the "Public API Only" boundary.

## Prevention

Enforce the "Public API Only" rule through code reviews and automated checks. Controllers should expose explicit public methods for all cross-controller operations rather than relying on internal property access patterns.

## References

- Related wiki: `wiki/subMDs/architecture/server_splitting.md`
- Related controller: `WorldStateController`, `actionController`
