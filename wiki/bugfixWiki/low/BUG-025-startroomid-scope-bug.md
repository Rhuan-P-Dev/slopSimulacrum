# BUG-025: `startRoomId` Scope Bug in `_spawnKnifeInStartRoom()`

- **Severity**: LOW
- **Status**: ✅ Fixed
- **Fixed In**: `41014fb3` (blueprint decoupling session)
- **Related Files**: `src/controllers/WorldStateController.js` (lines 127-133)

## Symptoms

Initial implementation of `_spawnKnifeInStartRoom()` referenced `startRoomId`, which was only in scope within the `initializeWorld()` method. This would cause a `ReferenceError` at runtime:

```
ReferenceError: startRoomId is not defined
    at WorldStateController._spawnKnifeInStartRoom (file:///src/controllers/WorldStateController.js:129:46)
```

## Root Cause

The `_spawnKnifeInStartRoom()` method was initially written as:

```javascript
_spawnKnifeInStartRoom() {
    const knifeEntityId = this.stateEntityController.spawnEntity('knife', startRoomId);
    this.stateEntityController.updateEntitySpatial(knifeEntityId, { x: -50, y: 30 });
}
```

`startRoomId` was a local variable inside `initializeWorld()`, not accessible from `_spawnKnifeInStartRoom()`.

## Fix

Resolved the room ID inside the method itself:

```javascript
_spawnKnifeInStartRoom() {
    const knifeRoomId = this.roomsController.getUidByLogicalId('start_room');
    const knifeEntityId = this.stateEntityController.spawnEntity('knife', knifeRoomId);
    this.stateEntityController.updateEntitySpatial(knifeEntityId, { x: -50, y: 30 });
}
```

## Prevention

- Keep helper methods self-contained — resolve dependencies locally rather than referencing outer scope variables
- Use a linter rule to catch `no-undef` references
- Test world initialization end-to-end before deploying

## References

- Related wiki: `wiki/subMDs/entities.md` Section 3.1
- Related controller: `WorldStateController`