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

| Method | Purpose |
|--------|---------|
| `checkGrabRange(sourceEntityId, targetEntityId, maxRange)` | Checks if a grab action is within range of the target entity. Accepts a number or expression string (e.g., `":Physical.strength*2"`). |
| `checkSpatialRange(sourceEntityId, targetX, targetY, maxRange)` | Checks if a spatial target point is within range of the source entity. Used for spatial actions (e.g. `dropItem`) where the client sends a target coordinate instead of a target entity. |
| `executeRangeFailureConsequences(entityId, actionName)` | Executes `rangeFailure` consequences defined in the action data |

### Why server-side spatial range enforcement?

Historically only entity-targeted actions (e.g. `punch`, `cut`) were range-checked on the server, via `checkGrabRange`. Spatial actions (e.g. `dropItem`) sent a target coordinate (`targetX`/`targetY`) rather than a target entity, so the client rendered a range indicator but the server never enforced it — a player could drop an item at any coordinate, regardless of the displayed range (the drop-range bug). `checkSpatialRange` closes that gap: it applies the **same** range expression (from `data/actions.json`, resolved via the shared `RangeResolver`) to a point target, so the actual enforced drop range always matches the range the client displays. The point-target failure message is also phrased for a coordinate ("Target is too far away") rather than a grab ("Item is too far away … Move closer to grab it"), since the target is a location, not an item.

## Range Expression Resolution

When `maxRange` is a string (e.g., `":Physical.strength*2"`), the shared `_resolveMaxRange()` helper resolves it to a validated numeric value before distance validation:

1. The entity-level `"trait.stat"` → `value` map is gathered via `RequirementResolver.resolveEntityRequirementValues()` — the single source of truth for entity-level stat maps, shared with the requirement-checking path (no duplicated component-scan logic).
2. `resolveRange()` (from the shared `RangeResolver`) resolves the expression using this map. The shared resolver is the single source of truth for all `:Trait.stat` range expressions across the action system, and is the same module the client uses to render the range indicator.
3. The resolved numeric value is validated — negative, zero, NaN, or non-finite values are rejected with a graceful failure (not a thrown exception).
4. The resolved numeric value is passed to `RangeChecker` for distance validation (`checkGrabRange()` for an entity target, `checkPointRange()` for a point target).

Because the same shared `RangeResolver` and the same range expression from `data/actions.json` are used on both server and client, the enforced range always matches the displayed range.

### Edge Case Handling

| Resolved Value | Behavior |
|----------------|----------|
| Valid positive number (e.g., `50`) | Proceeds to distance validation |
| Negative number (e.g., `-:Physical.mass` → `-20`) | Returns `{ success: false, error: 'Invalid range value: -20' }` |
| Unknown placeholder (e.g., `:Unknown.stat` → `NaN`) | Returns `{ success: false, error: 'Invalid range value: NaN' }` |
| Literal number string (e.g., `"20"`) | Converted via `Number()` → `20`, proceeds to validation |
| Unparseable string | Converted via `Number()` → `NaN`, returns validation error |

## Integration Points

| Controller | Relationship |
|------------|-------------|
| **ActionController** | Calls `checkGrabRange()` and `checkSpatialRange()` during action execution (via its range gate) and executes range-failure consequences on failure. Passes raw range value (number or expression string). |
| **RangeChecker** | Utility module used for distance computation. `checkGrabRange()` for entity targets, `checkPointRange()` for point targets. Receives resolved numeric maxRange. |
| **RequirementResolver** | Provides `resolveEntityRequirementValues()` — the entity-level stat map used to resolve range expressions (Single Source of Truth, shared with the requirement-checking path). |
| **RangeResolver (shared)** | Environment-agnostic `resolveRange()` — the single source of truth for `:Trait.stat` range expressions on both server and client. |

## Validation

Range validation fails safely — if the source or target entity is not found in the world state, the check returns a failure result rather than throwing. This ensures that missing entities do not crash the action pipeline. Missing `rangeFailure` consequences in the action data are handled gracefully by returning success with zero executed consequences.

## Related

- Related wiki: `wiki/subMDs/architecture/action_system.md` — Action pipeline architecture
- Related wiki: `wiki/subMDs/controllers/consequence_handler_architecture.md` — Consequence dispatch system
- Related wiki: `wiki/subMDs/controllers/requirement_resolver.md` — Entity-level requirement value resolution (shared stat map)
- Related controller: `ActionController`
- Related controller: `RequirementResolver`
- Related utility: `RangeChecker`
- Related shared module: `shared/RangeResolver.js` — Shared range-expression resolver (server + client)
- Related data file: `data/actions.json` — Action definitions with `rangeFailure` consequences
