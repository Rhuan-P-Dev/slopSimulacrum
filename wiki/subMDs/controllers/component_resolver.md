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

The public surface covers the resolution pipeline: sanitizing the component list supplied by callers (filtering malformed IDs), resolving the action's source component under the priority chain, and validating that a resolved component fits its expected binding role.

## Integration Points

| Controller | Why it interacts |
|------------|------------------|
| **ActionController** | Needs deterministic component resolution during action execution |
| **RequirementResolver** | Validates that resolved components satisfy the action's trait requirements |
| **WorldStateController** | Is the source of truth for entity and component data |

## Related Files

- Related wiki: `wiki/subMDs/architecture/action_system.md` — Action pipeline architecture
- Related wiki: `wiki/subMDs/controllers/requirement_resolver.md` — Requirement resolution
- Related wiki: `wiki/subMDs/controllers/component_selection.md` — Component locking system
- Related controller: `ActionController`, `RequirementResolver`
- Related data file: `data/actions.json` — Action definitions with `componentBinding`