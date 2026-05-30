# RangeValidator

## Purpose

Validates spatial range for proximity-based actions and executes failure consequences when range checks fail. Extracted from `ActionController` to adhere to the Single Responsibility Principle — range logic is decoupled from the main action execution pipeline.

## Design Decisions

### Why a separate RangeValidator?

Range validation requires entity position lookups and distance calculations that are orthogonal to the core action execution logic. Separating this into its own controller:

- **Prevents ActionController bloat** — range checking is a distinct concern from action dispatch and consequence handling
- **Enables independent testing** — range validation and failure consequence execution can be tested in isolation
- **Centralizes range failure behavior** — all range-related failure consequences flow through a single method, ensuring consistent error handling

### Why rangeFailure consequences?

Range validation failures are not simple rejections — they trigger defined consequences in `data/actions.json` (e.g., error messages, resource depletion, or state changes). By storing `rangeFailure` consequences in the action definition itself, the system remains fully data-driven: designers control what happens when a grab fails due to distance, without modifying code.

### Separation from RangeChecker utility

`RangeChecker` is a pure utility module that computes whether two entities are within a given distance. `RangeValidator` is a controller that orchestrates the full range check flow: resolving entities, delegating to `RangeChecker`, and executing consequences on failure. This separation follows the pattern of keeping pure computation in utilities and action orchestration in controllers.

## Public Methods

| Method | Purpose |
|--------|---------|
| `checkGrabRange(sourceEntityId, targetEntityId, maxRange)` | Checks if a grab action is within range of the target entity |
| `executeRangeFailureConsequences(entityId, actionName)` | Executes `rangeFailure` consequences defined in the action data |

## Integration Points

| Controller | Relationship |
|------------|-------------|
| **ActionController** | Calls `checkGrabRange()` and `executeRangeFailureConsequences()` during action execution |
| **RangeChecker** | Utility module used by `checkGrabRange()` for distance computation |

## Validation

Range validation fails safely — if the source or target entity is not found in the world state, the check returns a failure result rather than throwing. This ensures that missing entities do not crash the action pipeline. Missing `rangeFailure` consequences in the action data are handled gracefully by returning success with zero executed consequences.

## Related

- Related wiki: `wiki/subMDs/architecture/action_system.md` — Action pipeline architecture
- Related wiki: `wiki/subMDs/controllers/consequence_handler_architecture.md` — Consequence dispatch system
- Related controller: `ActionController`
- Related utility: `RangeChecker`
- Related data file: `data/actions.json` — Action definitions with `rangeFailure` consequences