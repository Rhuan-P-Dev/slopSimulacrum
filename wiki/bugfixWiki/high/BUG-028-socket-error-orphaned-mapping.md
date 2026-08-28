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

When `worldStateController.spawnEntity()` threw an exception (e.g., invalid room ID), the error was unhandled, the socket was never notified, and the `socketToEntityMap` could be left half-populated if the failure occurred after partial initialization.

## Fix

Three changes make the connection handler failure-safe:

- A centralized `cleanupSocketMapping()` helper despawns the entity and removes the socket mapping in one place, so every failure path (error, disconnect, spawn failure) shares identical cleanup semantics and can never diverge.
- A socket `error` event listener catches connection-level errors that were previously unhandled, so an error mid-incarnation cleans up the mapping instead of orphaning it.
- The incarnation sequence is wrapped in `try...catch` so that if entity spawning fails, the socket is notified of the failure and any partial state is cleaned up rather than left half-initialized.

The connection handler's JSDoc was also expanded to document the expected socket lifecycle.

## Prevention

- Always wrap socket.io event handlers that modify shared state in `try...catch` blocks
- Use centralized cleanup functions for resource management
- Register error event listeners on all socket connections
- Document socket lifecycle expectations in JSDoc comments

## References

- Related wiki: `wiki/subMDs/server_client_architecture.md`
- Related controller: `WorldStateController`
- Related bug: BUG-027 (server console.log instead of Logger — related to logging standards)