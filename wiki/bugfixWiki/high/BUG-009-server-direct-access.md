# BUG-009: Server Direct Sub-Controller Access

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: — (architectural fix)
- **Related Files**: `src/server.js`, `src/controllers/WorldStateController.js`

## Symptoms

The server (`server.js`) accessed sub-controllers directly instead of using `WorldStateController` public API methods:

```javascript
// BAD: Direct sub-controller access
worldStateController.stateEntityController.spawnEntity('droid', roomId);
worldStateController.roomsController.getUidByLogicalId('start_room');
```

This caused:
- Tight coupling between server and internal controller structure
- Breakage when internal controller structure changed
- Bypassed validation logic in the root controller

## Root Cause

The `WorldStateController` did not expose public wrapper methods for common operations. Server code reached into internal controller properties to perform actions.

## Fix

Implemented public API wrapper methods in `WorldStateController`:

```javascript
// ✅ GOOD: Use public API wrappers
worldStateController.spawnEntity('droid', roomId);
worldStateController.getRoomUidByLogicalId('start_room');
```

### Available Public Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `spawnEntity(blueprintName, roomId)` | `string`, `string` | `string` | Spawns an entity from a blueprint into a room |
| `despawnEntity(entityId)` | `string` | `boolean` | Despawns an entity and cleans up capabilities |
| `moveEntity(entityId, targetRoomId)` | `string`, `string` | `boolean` | Moves an entity to a different room |
| `getRoomUidByLogicalId(logicalId)` | `string` | `string\|null` | Resolves a logical room name to its UUID |

## Prevention

- Controllers must communicate via **Public APIs** only
- Never access another controller's internal variables (`this.entities`, `this.roomsController`, etc.)
- Follow the **Loose Coupling** principle from `wiki/code_quality_and_best_practices.md` Section 1.2
- Refer to `wiki/subMDs/controller_patterns.md` Section 5.1 for Server API Access rules

## References

- Related wiki: `wiki/subMDs/controller_patterns.md` Section 5.1
- Related wiki: `wiki/map.md` Section 5.1
- Related controller: `WorldStateController`
- Related bug: [BUG-017](../architectural/BUG-017-dual-state-bug.md)