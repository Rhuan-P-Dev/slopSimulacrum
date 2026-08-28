# BUG-074: Test Item Added to Server but Not Visible on Client (Broadcast Timing)

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/WorldStateController.js`, `src/server.js`

## Symptoms

- Test item (`testItem`, volume=2) is added to the client entity's `centralBall` on spawn
- Server-side entity has the item in its `items` array
- Client UI (inventory overlay) does not show the test item on the Central Ball component

## Root Cause

Dependency-injection ordering: the broadcast service is injected via `setBroadcastService()` **after** `WorldStateController` construction and `initializeWorld()` have already completed. Spawn-time item additions therefore happen while `_broadcastService` is still `null`, the broadcast guard inside item addition silently skips, and the server state (including the test item) is never pushed to clients. Why it was subtle: the server state was correct and no error was logged — the data simply never crossed the wire.

## Fix

Added a `triggerInitialBroadcast()` method to `WorldStateController` and call it from `server.js` **after** `setBroadcastService()`. Why this shape: the controller cannot broadcast during its own construction (the service does not exist yet by DI order), so the server explicitly triggers one full-state broadcast once wiring is complete. This ensures:

- All entities are fully initialized
- Test items and other spawn-time data are added
- Broadcast service is active
- Complete state sync to clients

## Prevention

- When adding data during initialization, always verify the broadcast service is active
- Use a dedicated `triggerInitialBroadcast()` method called after broadcast service injection
- Never rely on `this._broadcastService` being available during constructor/initialization

## References
- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related controller: `WorldStateController`, `WorldStateBroadcastService`