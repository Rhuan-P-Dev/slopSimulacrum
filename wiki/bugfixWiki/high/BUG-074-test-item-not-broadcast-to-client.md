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

The broadcast service (`_broadcastService`) is `null` during `WorldStateController` initialization:

1. `WSC` constructor runs → `initializeWorld()` → spawns entity → adds test item
2. Inside `addItemToEntity()`, the check `if (result.success && this._broadcastService)` fails because `_broadcastService` is `null` (initialized on line 111, injected via `setBroadcastService()` on `server.js` line 27)
3. `setBroadcastService(broadcastService)` is called **AFTER** the WSC constructor completes
4. The entity's `items` array exists on the server but the state is never broadcast to clients

## Fix

Added `triggerInitialBroadcast()` method to `WorldStateController` that is called from `server.js` **after** `setBroadcastService()`:

### WorldStateController.js
```javascript
triggerInitialBroadcast() {
    if (this._broadcastService) {
        this._broadcastService.broadcast();
        Logger.info('[WorldStateController] Initial broadcast triggered after broadcast service injection.');
    } else {
        Logger.warn('[WorldStateController] Broadcast service not available for initial broadcast.');
    }
}
```

### server.js
```javascript
// After setBroadcastService
worldStateController.triggerInitialBroadcast();
```

This ensures:
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