# BUG-124: _checkItemFit Does Not Account for Container Volume

- **Severity**: MEDIUM
- **Status**: 🔴 Open
- **Fixed In**: —
- **Related Files**: [`public/js/InventoryManager.js`](public/js/InventoryManager.js) (lines 1064-1091)

## Symptoms

The client-side volume check only accounts for items held directly by the target component. It does not account for items inside containers on that component, so drag-and-drop could allow a placement that would exceed the component's total volume once container contents are included.

## Root Cause

The client-side volume check was not updated when nested inventory was added. The server-side `InventoryManager` tracks container item volumes, but the client-side `_checkItemFit()` only considers direct component items.

## Fix

The client-side fit check (`_checkItemFit()`) needs to include the volume of items inside containers on the target component, so the client's validation mirrors the server-side nested-volume rule and the UI cannot accept a placement the server would reject.

## Prevention

Client-side validation should mirror server-side validation for all inventory operations. When server-side logic is updated (e.g., adding nested inventory), corresponding client-side checks must be updated in tandem.

## References

- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related controller: `InventoryManager` (client-side)
