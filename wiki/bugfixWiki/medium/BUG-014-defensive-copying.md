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

Entity objects were passed by reference and modified directly without creating copies. This caused:
- Side effects in unrelated code that held references to the same entity
- Capability cache not reflecting actual state (stale references)
- Save/Load producing corrupted data (shared references between entities)

## Fix

Enforced defensive copying throughout the entity management system: entities are deep-copied when returned and when updates are applied, so external code cannot mutate internal state through shared references and state snapshots never alias live objects.

## Prevention

- Never return internal state directly — always return a copy
- Never mutate received objects — clone first
- Follow the **Long-term State Persistence** principle from `wiki/code_quality_and_best_practices.md` Section 6.2

## References

- Related wiki: `wiki/subMDs/entities.md`
- Related wiki: `wiki/subMDs/world_state.md`
- Related controller: `EntityController`
- Git commit: `d2e8c0b`
- Related bug: [BUG-008](../high/BUG-008-state-desync.md)