# BUG-008: State Desynchronization Between Save/Load

- **Severity**: HIGH
- **Status**: ✅ Documented (process fix, not code fix)
- **Fixed In**: — (governance standard)
- **Related Files**: `src/controllers/WorldStateController.js`, `src/controllers/stateEntityController.js`

## Symptoms

After saving and reloading game state:
- Entity positions were incorrect
- Component stats were partially lost
- Room associations were broken
- The simulation state differed from what was saved

## Root Cause

1. **Incomplete Serialization**: Not all state was serializable — some controller internal state was not included in the save snapshot
2. **Direct State Mutation**: Controllers modified internal state directly instead of using the serialized save/load cycle
3. **No State Validation**: Loaded state was not validated against the expected schema

## Fix (Process)

Documented the mandatory state serialization requirement in `wiki/code_quality_and_best_practices.md` Section 6.2:

> **Long-term State Persistence**: The game state must be fully serializable (capable of being converted to JSON/File) at any moment to ensure reliable Save/Load functionality.

Additionally, the `WorldStateController` architecture ensures all state flows through serializable data structures:
- `stateEntityController` manages entity instances
- `ComponentStatsController` manages numeric state
- `RoomsController` manages spatial state

## Prevention

- All state must be serializable to JSON at any time
- Implement `serialize()` and `deserialize()` methods for stateful controllers
- Validate loaded state against expected schema before use
- Follow the **Single Source of Truth** principle — state changes go through the root controller

## References

- Related wiki: `wiki/subMDs/world_state.md`
- Related wiki: `wiki/subMDs/controller_patterns.md`
- Related controller: `WorldStateController`
- Related bug: [BUG-005](../high/BUG-005-deep-trait-merge.md)