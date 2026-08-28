# RequirementResolver

## Purpose

Resolves action requirements to component stats, determining whether an entity or specific component meets the trait-based requirements defined in an action's `requirements` array.

**Architecture**: Extracted from `ActionController` to adhere to the Single Responsibility Principle. While the capability controller performs pre-computed scoring, `RequirementResolver` performs exact requirement validation at action execution time with full context of equipped items and host component state.

## Design Decisions

### Why a separate RequirementResolver?

Requirement resolution involves complex logic for handling equipped items, host component fallback, and trait mapping. Separating this into its own controller:

- **Prevents ActionController bloat** — requirement validation logic is extensive, involving entity resolution, equipped item trait resolution, and component-specific checks
- **Enables independent testing** — each resolution path can be tested in isolation
- **Supports equipped item semantics** — equipped items require special resolution paths that differ from normal component stats

### Why equipped item trait resolution?

When a component hosts an equipped item (e.g., a knife in a droid hand), the item's traits may satisfy action requirements that the host component cannot. A knife's `sharpness` enables the `cut` action even if the host component has no sharpness trait. Without equipped item trait resolution, equipped items would be invisible to the requirement system, and actions that depend on item-specific traits would never appear.

Resolution answers one question: which stats should a requirement be checked against — the host component's own stats, the traits of an equipped item (which can satisfy requirements the host lacks), or a specific equipped item referenced by ID, so consequences can target that item's per-instance stats directly. When an equipped item can satisfy a requirement it takes precedence over the host; otherwise the host's stats apply.

### Why store the equipped item's itemId in fulfillingComponents?

The `fulfillingComponents` map is used by consequence handlers to determine which target to modify. When an equipped item's traits satisfy a requirement, the map stores the item's actual `itemId` rather than a synthetic or host ID. This ensures that consequences (e.g., sharpness drain) target the equipped item's per-instance stats store, not the host component.

### Why separation from ComponentResolver?

`RequirementResolver` handles **whether a component satisfies** the action's trait-based requirements. `ComponentResolver` handles **which component ID** participates in the action. A component can be validly resolved (identity known) but still fail requirements (insufficient stats). Keeping these separate allows the capability controller to score components independently of the execution-time validation that `RequirementResolver` provides.

## Public Methods

The public surface answers the questions the action pipeline asks at execution time: can this entity satisfy a requirement set across any combination of its components, does this specific component (or its equipped item) satisfy all of an action's requirements, and what resolved trait values apply to a component — the last used by binding validation.

## Integration Points

| Controller | Why it interacts |
|------------|------------------|
| **ActionController** | Needs exact requirement validation at execution time, with full context of equipped items and host component state |
| **ComponentResolver** | Needs resolved trait values to validate component bindings |
| **WorldStateController** | Is the source of truth for component stats, equipped items, and item definitions |

## Validation

RequirementResolver validates that resolved values are numeric. Non-numeric trait properties are excluded from requirement evaluation, ensuring that string or boolean traits in inventory items do not cause validation errors.

## Related Files

- Related wiki: `wiki/subMDs/architecture/action_system.md` — Action pipeline architecture
- Related wiki: `wiki/subMDs/controllers/component_resolver.md` — Component resolution (calls RequirementResolver)
- Related wiki: `wiki/subMDs/controllers/equipped_item_stats_controller.md` — Per-instance mutable stat tracking
- Related controller: `ActionController`, `ComponentResolver`
- Related data file: `data/inventoryItems.json` — Item definitions with traits
- Related data file: `data/actions.json` — Action definitions with requirements