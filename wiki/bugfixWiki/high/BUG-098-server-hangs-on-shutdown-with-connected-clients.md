# BUG-098: Server Hangs Indefinitely on Shutdown When Clients Are Connected

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/server.js` (lines 35-69, `gracefulShutdown` function)

## Symptoms

When the server receives SIGINT or SIGTERM (Ctrl+C or `kill` command), it fails to shut down if any browser client has an active WebSocket connection. The `gracefulShutdown` function calls `io.close()` and then `server.close()`, but the `server.close()` callback never fires because browsers do not promptly close their WebSocket connections. The server appears to "hang" and requires manual termination or closing the client browser tab to proceed.

## Root Cause

Socket.IO 4.x's `io.close()` followed by `http.Server.close()` waits for **all** existing WebSocket connections to close gracefully before emitting the `'close'` event. Modern browsers (especially Chrome/Edge with service workers) often keep WebSocket connections open for extended periods during page unload, or close them lazily. This causes `server.close()` to hang indefinitely — the 60-second timeout in the original code was a workaround but still too long for developer productivity.

**Specifically:**
1. `io.close()` closes new incoming connections but does NOT forcibly close existing ones
2. `server.close()` waits for all underlying connections to drain
3. Browser WebSocket connections linger, preventing the drain
4. `server.close()` callback never fires until the 60-second forced exit

## Fix

Added `io.sockets.disconnect(true)` **before** calling `io.close()`. The `true` parameter forces immediate TCP connection closure for all connected sockets, without waiting for client acknowledgment.

### Code Change

```diff
 // Disconnect all Socket.IO clients
 if (io) {
+    const socketCount = io.sockets?.sockets?.size || 0;
+    if (socketCount > 0) {
+        Logger.info(`[Server] Force disconnecting ${socketCount} connected client(s)...`);
+        io.sockets.disconnect(true); // true = force immediate disconnect
+    }
     io.close();
 }
```

Also reduced the forced exit timeout from 60 seconds to 10 seconds, since the force disconnect handles the primary case.

## Prevention

- When implementing server shutdown logic with Socket.IO, always use `io.sockets.disconnect(true)` before `io.close()` if you need to guarantee shutdown completes
- Never rely solely on `server.close()` to drain WebSocket connections in production environments where browsers may keep connections alive
- Use optional chaining (`io.sockets?.sockets?.size`) to guard against undefined access when Socket.IO state is in unexpected conditions

## References

- Socket.IO 4.x API: [`Server#disconnectAll()`](https://socket.io/docs/v4/server-api/#serverdisconnectallforce)
- Socket.IO 4.x API: [`Server#close()`](https://socket.io/docs/v4/server-api/#serverclose)
- Related wiki: `wiki/subMDs/architecture/server_client_architecture.md`
- Related controller: `SocketLifecycleController`