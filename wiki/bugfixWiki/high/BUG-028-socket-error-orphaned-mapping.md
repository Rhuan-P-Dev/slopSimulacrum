# BUG-028: Socket Error Causes Orphaned Entity Mapping

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/server.js` (lines 48-110)

## Symptoms

When a WebSocket connection encounters an error during the incarnation phase (entity spawning), the `socketToEntityMap` retains an orphaned entry mapping the socket ID to an entity that was never created. This can cause:

1. Memory leaks as the map grows with invalid entries
2. Failed cleanup on subsequent disconnect events
3. Inconsistent state between the server's entity registry and the socket mapping

## Root Cause

The socket.io `connection` handler lacked:
1. An `error` event listener on the socket to catch connection errors
2. A `try...catch` block around the entity spawning logic
3. A centralized cleanup function for socket mapping removal

When `worldStateController.spawnEntity()` threw an exception (e.g., invalid room ID), the error was unhandled, the socket was never notified, and the `socketToEntityMap` entry was never added — but if the error occurred AFTER partial initialization, the map could be left in an inconsistent state.

```javascript
// BEFORE (vulnerable):
io.on('connection', (socket) => {
    // No error handler
    // No try/catch around spawn
    const entityId = worldStateController.spawnEntity('smallBallDroid', startRoomId);
    socketToEntityMap.set(socket.id, entityId);
    // If spawnEntity throws, socket is never notified and map is inconsistent
});
```

## Fix

1. **Added `cleanupSocketMapping()` helper function** (lines 48-57):
   - Centralizes socket-to-entity cleanup logic
   - Despawns the entity and removes the map entry atomically
   - Logs the cleanup action for debugging

2. **Added socket error event listener** (lines 71-74):
   ```javascript
   socket.on('error', (error) => {
       Logger.error('Socket error', { socketId: socket.id, error: error.message });
       cleanupSocketMapping(socket.id);
   });
   ```

3. **Wrapped incarnation logic in try...catch** (lines 76-104):
   ```javascript
   try {
       // ... spawn logic ...
   } catch (error) {
       Logger.error('Failed to incarnate player', { socketId: socket.id, error: error.message });
       socket.emit('error', { message: 'Failed to incarnate player entity.' });
       cleanupSocketMapping(socket.id);
       return;
   }
   ```

4. **Improved JSDoc documentation** for the connection handler with bullet points explaining the lifecycle.

## Prevention

- Always wrap socket.io event handlers that modify shared state in `try...catch` blocks
- Use centralized cleanup functions for resource management
- Register error event listeners on all socket connections
- Document socket lifecycle expectations in JSDoc comments

## References

- Related wiki: `wiki/subMDs/server_client_architecture.md`
- Related controller: `WorldStateController`
- Related bug: BUG-027 (server console.log instead of Logger — related to logging standards)