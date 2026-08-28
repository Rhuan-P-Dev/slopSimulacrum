# RangeValidator

## Purpose

Validates spatial range for proximity-based actions and executes failure consequences when range checks fail. Extracted from `ActionController` to adhere to the Single Responsibility Principle — range logic is decoupled from the main action execution pipeline.

Range values in `data/actions.json` support the same **expression syntax** as consequences (e.g., `":Physical.strength*2"`), resolved at check time by the same `PlaceholderResolver` mechanism. This ensures consistency across all data-driven expressions in the action system.

## Design Decisions

### Why a separate RangeValidator?

Range validation requires entity position lookups and distance calculations that are orthogonal to the core action execution logic. Separating this into its own controller:

- **Prevents ActionController bloat** — range checking is a distinct concern from action dispatch and consequence handling
- **Enables independent testing** — range validation and failure consequence execution can be tested in isolation
- **Centralizes range failure behavior** — all range-related failure consequences flow through one central entry point, ensuring consistent error handling

### Why rangeFailure consequences?

Range validation failures are not simple rejections — they trigger defined consequences in `data/actions.json` (e.g., error messages, resource depletion, or state changes). By storing `rangeFailure` consequences in the action definition itself, the system remains fully data-driven: designers control what happens when a grab fails due to distance, without modifying code.

### Separation from RangeChecker utility

`RangeChecker` is a pure utility module that computes whether two entities are within a given distance. `RangeValidator` is a controller that owns the full range-check concern, including its failure consequences. This separation follows the pattern of keeping pure computation in utilities and action orchestration in controllers.

## Public Methods

The public surface covers two responsibilities: checking whether a source entity is within range of a target for a given range (numeric or expression), and executing the action's `rangeFailure` consequences when a check fails.

## Range Expression Resolution

Expression ranges are resolved through the same `PlaceholderResolver` path that consequences use, so the action system has a single resolution mechanism for all `:Trait.stat` expressions rather than a second one for ranges. Resolved values that cannot form a valid range — negative, zero, unparseable, or non-finite — produce a graceful failure result instead of a thrown exception: a malformed range degrades the action cleanly instead of crashing the pipeline.

## Integration Points

`ActionController` delegates both range checking and range-failure consequence execution to this controller, passing the raw range value (number or expression). Distance computation itself is delegated to the `RangeChecker` utility, and expression resolution to `PlaceholderResolver` — the same mechanism used by consequences.

## Validation

Range validation fails safely — if the source or target entity is not found in the world state, the check returns a failure result rather than throwing. This ensures that missing entities do not crash the action pipeline. Missing `rangeFailure` consequences in the action data are handled gracefully by returning success with zero executed consequences.

## Related

- Related wiki: `wiki/subMDs/architecture/action_system.md` — Action pipeline architecture
- Related wiki: `wiki/subMDs/controllers/consequence_handler_architecture.md` — Consequence dispatch system
- Related controller: `ActionController`
- Related utility: `RangeChecker`
- Related data file: `data/actions.json` — Action definitions with `rangeFailure` consequences
