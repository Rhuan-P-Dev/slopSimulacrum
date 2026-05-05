# BUG-040: Equipment Registry Memory Leak on Entity Despawn

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/equipmentController.js`, `src/controllers/stateEntityController.js`, `src/controllers/WorldStateController.js`

## Symptoms
- `EquipmentController._grabRegistry` and `EquipmentController._backpackRegistry` are never cleaned when an entity is despawned
- Grabbed items and backpack entries persist in memory after entity removal
- Memory grows unbounded as entities spawn/despawn with items
- Released items don't respawn because the registry still holds stale entries

## Root Cause
`stateEntityController.despawnEntity(entityId)` removed the entity but did NOT call `EquipmentController.releaseEntityGrabs(entityId)` to clean up equipment registries.

```javascript
// Before (line 84-94):
despawnEntity(entityId) {
    if (this.entities[entityId]) {
        if (this.actionController) {
            this.actionController.removeEntityFromCache(entityId);
        }
        delete this.entities[entityId];  // ❌ Equipment not cleaned!
        return true;
    }
    return false;
}
```

## Fix
1. Added `releaseEntityGrabs(entityId)` method to `EquipmentController` that:
   - Releases all hand grabs → respawns items in world via `releaseItem()`
   - Releases all backpack items → respawns items in world via `releaseBackpackItem()`
   - Clears `_grabRegistry` and `_backpackRegistry` entries for the entity
2. Injected `equipmentController` into `stateEntityController` constructor
3. Added cleanup call in `despawnEntity()`:

```javascript
// After:
despawnEntity(entityId) {
    if (this.entities[entityId]) {
        // Clean up equipment registries (hand grabs + backpack) before despawning
        if (this.equipmentController) {
            this.equipmentController.releaseEntityGrabs(entityId);
        }
        if (this.actionController) {
            this.actionController.removeEntityFromCache(entityId);
        }
        delete this.entities[entityId];
        return true;
    }
    return false;
}
```

## Prevention
- When despawning entities, always clean up all registries that reference the entity
- Use DI pattern: inject dependencies at construction, not via `this.something.worldStateController`
- Register cleanup in a single location (`despawnEntity`) rather than scattered across controllers

## References
- Related wiki: `wiki/subMDs/equipment_system.md`
- Related controller: `EquipmentController`
- DI pattern: `wiki/subMDs/controller_patterns.md`