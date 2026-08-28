# BUG-025: `startRoomId` Scope Bug in `_spawnKnifeInStartRoom()`

- **Severity**: LOW
- **Status**: ✅ Fixed
- **Fixed In**: `41014fb3` (blueprint decoupling session)
- **Related Files**: `src/controllers/WorldStateController.js` (lines 127-133)

## Symptoms

The initial implementation of `_spawnKnifeInStartRoom()` referenced `startRoomId`, which was only in scope within the `initializeWorld()` method. This threw a `ReferenceError` (`startRoomId is not defined`) at runtime, breaking world initialization.

## Root Cause

`startRoomId` was a local variable inside `initializeWorld()`, not accessible from `_spawnKnifeInStartRoom()` — the helper depended on an outer-scope variable it could not see.

## Fix

The method now resolves the room ID itself via the rooms controller's public lookup (logical ID → UID) instead of referencing the outer-scope variable. Rationale: helper methods must be self-contained, and resolving room identity through the rooms controller's public API preserves the single source of truth for room UIDs.

## Prevention

- Keep helper methods self-contained — resolve dependencies locally rather than referencing outer scope variables
- Use a linter rule to catch `no-undef` references
- Test world initialization end-to-end before deploying

## References

- Related wiki: `wiki/subMDs/entities.md` Section 3.1
- Related controller: `WorldStateController`