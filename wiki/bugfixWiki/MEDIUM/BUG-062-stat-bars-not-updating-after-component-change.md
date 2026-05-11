# BUG-062: Stat Bars Created via "➕ Add Stat" Don't Update When Component Stats Change

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/server.js`, `src/controllers/WorldStateController.js`, `public/js/EventDispatcher.js`, `public/js/App.js`

## Symptoms

When a component's stat changes (e.g., via action consequences like damage or healing), custom stat bars created via the **"➕ Add Stat"** feature do not update their fill percentage. The bars are correctly created and show the initial value, but remain static after server-side stat changes.

## Root Cause

The bug had **two independent causes** (server-side and client-side):

### Server-Side: Broadcast Not Triggered by Stat Changes

The `WorldStateBroadcastService.broadcast()` was only called in HTTP route handlers:
- `actionRoutes.js` — after successful action execution
- `worldRoutes.js` — after successful move-entity

When `ComponentController.updateComponentStatDelta()` or `updateComponentStat()` changed a stat, it notified `_statChangeListeners` (for capability re-evaluation), but **never triggered a broadcast**. This meant stat changes that didn't go through the route handlers (e.g., direct stat modifications) were never sent to clients.

### Client-Side: State Desync Between Socket Payload and WorldStateManager

When `onStatBarsUpdate(data.state)` was called:
- The `state` parameter (socket payload) had fresh component stats ✅
- But `this._worldStateManager.state` still held the **old state** from the previous `fetchState()` ❌
- `StatBarsManager.updateAll()` calls `this._worldStateManager.getActiveDroid()` which reads from `this._worldStateManager.state`
- Since internal state was stale, `getActiveDroid()` returned `null` and `updateAll()` silently exited
- The stat bars never updated because the droid lookup failed against stale internal state

## Fix

### Server-Side: Wire Broadcast into Stat Change Observer

**`src/controllers/WorldStateController.js`** — Extended the existing stat change listener to also trigger broadcast:

```javascript
this.componentController.registerStatChangeListener((componentId, traitId, statName, newValue, oldValue) => {
    this.componentCapabilityController.onStatChange(componentId, traitId, statName, newValue, oldValue);
    // NEW: Trigger broadcast if broadcastService is available
    if (this._broadcastService) {
        this._broadcastService.broadcast();
    }
});
```

**`src/server.js`** — Inject broadcast service into WorldStateController:

```javascript
worldStateController.setBroadcastService(broadcastService);
```

**`src/controllers/WorldStateController.js`** — Added `setBroadcastService()` method:

```javascript
setBroadcastService(broadcastService) {
    this._broadcastService = broadcastService;
}
```

### Client-Side: Sync WorldStateManager State Before Calling updateAll()

**`public/js/App.js`** — Fixed `onStatBarsUpdate` handler to sync `WorldStateManager.state` first:

```javascript
'world-state-update': (data) => {
    console.log('[EventDispatcher] WORLD STATE UPDATE SIGNAL', data?.state ? '(with payload)' : '(no payload)');
    // Immediately update stat bars with the state payload (fast path)
    if (this.handlers.onStatBarsUpdate && data?.state) {
        this.handlers.onStatBarsUpdate(data.state);
    }
    // Then do full refresh for other UI components
    if (this.handlers.refreshWorldAndActions) {
        this.handlers.refreshWorldAndActions();
    }
},
```

**`public/js/App.js`** — Added `onStatBarsUpdate` handler:

```javascript
onStatBarsUpdate: (state) => {
    this.worldState.state = state;  // Sync so getActiveDroid() reads fresh data
    this.statBars.updateAll(state);
},
```

## Prevention

1. **Server**: When adding new stat mutation paths (not just HTTP routes), ensure they trigger broadcast via the stat change observer.
2. **Client**: When socket events carry state payloads, use them for targeted UI updates instead of always discarding and re-fetching.
3. **Architecture**: The stat change observer pattern should be the single source of truth for "something changed" notifications — any system that needs to react to stat changes should register as a listener.

## References
- Related wiki: `wiki/subMDs/world_state.md`
- Related wiki: `wiki/subMDs/client_ui.md`
- Related controllers: `ComponentController`, `WorldStateController`, `StatBarsManager`
- Related bugs: [BUG-060](medium/BUG-060-add-stat-not-component-related.md), [BUG-061](medium/BUG-061-stat-bar-not-updating-after-add.md)