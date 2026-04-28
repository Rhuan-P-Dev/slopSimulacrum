# BUG-014: Entity State Direct Mutation

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `d2e8c0b` ("refactor(state): enforce defensive copying and wire capability listeners")
- **Related Files**: `src/controllers/entityController.js`

## Symptoms

When entity state was modified:
- Other parts of the system saw unexpected mutations
- Capability cache became out of sync with actual entity state
- Saving state produced corrupted snapshots with shared references

## Root Cause

Entity objects were passed by reference and modified directly without creating copies:

```javascript
// ❌ BEFORE (direct mutation - buggy)
entity.components.push(newComponent);  // Mutates original entity!
entity.stats.durability = 50;          // Mutates original stats!
```

This caused:
- Side effects in unrelated code that held references to the same entity
- Capability cache not reflecting actual state (stale references)
- Save/Load producing corrupted data (shared references between entities)

## Fix

Enforced defensive copying throughout the entity management system:

```javascript
// ✅ AFTER (defensive copying - fixed)
// Deep clone before returning
getEntity(entityId) {
    return JSON.parse(JSON.stringify(this.entities[entityId]));
}

// Deep clone before mutating
updateEntity(entityId, updates) {
    const entity = JSON.parse(JSON.stringify(this.entities[entityId]));
    // Apply updates to the clone
    Object.assign(entity, updates);
    // Save the clone
    this.entities[entityId] = JSON.parse(JSON.stringify(entity));
}
```

### Defensive Copying Rules

| Operation | Copy Type | Reason |
|-----------|-----------|--------|
| **Returning entity** | Deep copy | Prevents external mutation |
| **Accepting updates** | Deep copy | Prevents reference pollution |
| **Internal storage** | Deep copy | Ensures isolation |
| **Capability cache entries** | Deep copy | Prevents stale references |

## Prevention

- Never return internal state directly — always return a copy
- Never mutate received objects — clone first
- Follow the **Long-term State Persistence** principle from `wiki/code_quality_and_best_practices.md` Section 6.2
- Use `JSON.parse(JSON.stringify(obj))` for deep cloning in JavaScript

## References

- Related wiki: `wiki/subMDs/entities.md`
- Related wiki: `wiki/subMDs/world_state.md`
- Related controller: `EntityController`
- Git commit: `d2e8c0b`
- Related bug: [BUG-008](../high/BUG-008-state-desync.md)