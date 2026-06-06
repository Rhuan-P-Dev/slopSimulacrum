# BUG-099: Knife Cut Damage Always Uses Base Sharpness (50), Ignoring Sharpness Drain

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/consequences/DamageConsequenceHandler.js`, `src/controllers/consequences/consequenceHandlers.js`, `src/controllers/WorldStateController.js`

## Symptoms

When the knife is equipped (sharpness = 50 from `inventoryItems.json`):
- **First cut**: Deals 50 damage ✓ (sharpness is 50)
- **Second cut**: Deals 50 damage ✗ (sharpness is actually 49, but still deals 50)
- **Subsequent cuts**: Always deal 50 damage ✗ (sharpness keeps draining to 48, 47, etc., but damage never changes)

The sharpness drain consequence (`-1` per cut) was not properly routing to the equipped item's mutable stats. The consequence handler chain was missing proper routing for equipped item damage.

## Root Cause

Three interconnected wiring issues in the consequence handler chain prevented proper equipped item stat routing:

### 1. `DamageConsequenceHandler` Lacked Equipped Item Routing

The damage handler only accepted `worldStateController` in its constructor. It had no access to `EquippedItemStatsController`, so when the target was an equipped item's eqId, damage was always applied to the host component instead of the item itself.

### 2. `ConsequenceHandlers` Constructor Didn't Pass `equippedItemStats`

The `ConsequenceHandlers` constructor received only `{ worldStateController: this }`. It created `StatConsequenceHandler` with this object (which didn't include `equippedItemStats`), then relied on post-construction injection. `DamageConsequenceHandler` received the same incomplete object.

### 3. `WorldStateController` Stat Change Callback Had Wrong Iteration

The stat change callback iterated over `getAllEquippedItems()` using `Object.entries(items)`, which is correct for the nested object returned by `HoldingCostController.getAllEquippedItems()`. However, `WorldStateController.getAllEquippedItems()` returns a flattened array **without** the `eqId` field, making it impossible for the callback to match eqIds from `EquippedItemStatsController._notifyStatChange`.

## Fix

### 1. `src/controllers/consequences/DamageConsequenceHandler.js`

Added `equippedItemStats` to constructor and equipped-item routing in `_handleDamageComponent`:

```javascript
constructor(controllers) {
    this.worldStateController = controllers.worldStateController;
    this.equippedItemStats = controllers.equippedItemStats || null;
}

_handleDamageComponent(targetId, resolvedParams, context) {
    // ...
    // Check if target is an equipped item — route to EquippedItemStatsController
    if (this.equippedItemStats?.hasStats(targetId)) {
        const success = this.equippedItemStats.updateStatDelta(targetId, trait, stat, value);
        return {
            success,
            message: success ? `Dealt ${Math.abs(value)} damage to ${targetId}` : `Failed to damage ${targetId}`,
            data: success ? { targetId, trait, stat, value } : null
        };
    }
    // ... fall through to component damage
}
```

### 2. `src/controllers/consequences/consequenceHandlers.js`

Pass `equippedItemStats` to both `StatConsequenceHandler` and `DamageConsequenceHandler` at construction time:

```javascript
constructor(controllers) {
    this.worldStateController = controllers.worldStateController;
    this.equippedItemStats = controllers.equippedItemStats || null;

    this.spatialHandler = new SpatialConsequenceHandler(controllers);
    this.statHandler = new StatConsequenceHandler(controllers);
    // Pass equippedItemStats so DamageConsequenceHandler can route equipped item damage correctly
    const damageControllers = { ...controllers, equippedItemStats: this.equippedItemStats };
    this.damageHandler = new DamageConsequenceHandler(damageControllers);
    this.logHandler = new LogConsequenceHandler();
    this.eventHandler = new EventConsequenceHandler();
}
```

### 3. `src/controllers/WorldStateController.js`

**a.** Pass `equippedItemStats` to `ConsequenceHandlers` constructor:

```javascript
const consequenceHandlers = new ConsequenceHandlers({
    worldStateController: this,
    equippedItemStats: equippedItemStats
});
```

**b.** Remove redundant post-construction injection:

```javascript
// REMOVED: consequenceHandlers.statHandler.equippedItemStats = equippedItemStats;
// (No longer needed — now injected at construction time)
```

**c.** Fix stat change callback to iterate using direct key lookup:

```javascript
equippedItemStats.setStatChangeCallback((eqId, traitId, statName, newValue, oldValue) => {
    // HoldingCostController.getAllEquippedItems() returns: { [entityId]: { [eqId]: itemData } }
    const allEquipped = this.holdingCostController.getAllEquippedItems();
    for (const [entityId, items] of Object.entries(allEquipped)) {
        if (items[eqId]) {  // Direct key lookup instead of Object.entries(items)
            // Entity found — re-evaluate its capabilities
            const state = this.getAll();
            this.actionController.reEvaluateEntityCapabilities(state, entityId);
            if (this._broadcastService) {
                this._broadcastService.broadcast();
            }
            return;
        }
    }
});
```

**d.** Fix `getAllEquippedItems()` to include `eqId` in returned objects:

```javascript
getAllEquippedItems() {
    const allEquipped = this.holdingCostController.getAllEquippedItems();
    // ...
    for (const [entityId, items] of Object.entries(allEquipped)) {
        for (const [eqId, item] of Object.entries(items)) {
            allItems.push({
                entityId,
                eqId,  // ← Added: eqId was missing before
                itemId: item.itemId,
                itemType: item.itemType,
                componentId: item.componentId
            });
        }
    }
    return allItems;
}
```

## Prevention

1. **Always inject equipped item stats at construction time** — never rely on post-construction injection when the injected dependency is needed in the constructor.
2. **Verify iteration patterns** — when a callback passes `eqId` as a parameter, ensure the data source's return format matches the iteration pattern used.
3. **Include all identifiers in flattened data** — public API methods that flatten nested structures should include all relevant identifiers (especially `eqId`).

## References

- Related wiki: `wiki/subMDs/systems/sharpness_system.md`
- Related controller: `DamageConsequenceHandler`, `StatConsequenceHandler`, `ConsequenceHandlers`, `EquippedItemStatsController`
- Related bug: [BUG-096](high/BUG-096-knife-sharpness-drain-not-working.md) — sharpness drain not applied at all
- Related bug: [BUG-097](high/BUG-097-cut-action-disappears-after-use.md) — capability cache staleness