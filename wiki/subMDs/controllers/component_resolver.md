# ComponentResolver

## Purpose

Resolves source and target components for actions based on binding rules defined in action definitions. Determines which component(s) participate in an action based on targeting type, component binding configuration, and explicit parameters.

**Architecture**: Extracted from `ActionController` to adhere to the Single Responsibility Principle. Handles the priority-based resolution of component IDs during action execution.

## Design Decisions

### Why a priority-based resolution chain?

Actions can be invoked with varying levels of explicit component information depending on the interaction context. A client selecting an action manually provides full details, while an automated system trigger may provide minimal context. The priority chain ensures deterministic resolution regardless of how much context the caller provides, preventing ambiguity and ensuring actions execute correctly even when the caller doesn't provide component-level details.

### Why malformed ID rejection?

The resolver explicitly rejects component IDs containing `undefined` or `null` placeholders. This prevents accidental execution against invalid components when equipment state or parameter passing is broken. Malformed IDs are filtered early in the resolution pipeline, failing fast before game logic processes invalid targets.

### Why separation from RequirementResolver?

`ComponentResolver` handles **which component** participates in an action. `RequirementResolver` handles **whether the component satisfies** the action's requirements. These are distinct concerns: one resolves identity, the other validates capability. Keeping them separate allows each to evolve independently — for example, adding new binding types doesn't affect requirement checking, and vice versa.

## Public Methods

| Method | Purpose |
|--------|---------|
| `buildComponentList(params)` | Builds a validated component list from action parameters, filtering malformed IDs |
| `resolveSourceComponent(action, entityId, params, fallbackResult)` | Resolves the source component ID using the priority chain |
| `validateComponentBinding(action, entityId, sourceComponentId, params)` | Validates that a resolved component matches the expected binding role |

## Integration Points

| Controller | Relationship |
|------------|-------------|
| **ActionController** | Calls `resolveSourceComponent()` and `validateComponentBinding()` during execution |
| **RequirementResolver** | Used for binding validation of trait requirements |
| **WorldStateController** | Provides entity and component data access |

## Related Files

- Related wiki: `wiki/subMDs/architecture/action_system.md` — Action pipeline architecture
- Related wiki: `wiki/subMDs/controllers/requirement_resolver.md` — Requirement resolution
- Related wiki: `wiki/subMDs/controllers/component_selection.md` — Component locking system
- Related controller: `ActionController`, `RequirementResolver`
- Related data file: `data/actions.json` — Action definitions with `componentBinding`