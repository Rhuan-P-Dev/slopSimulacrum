# Internal Components Data Model

## Purpose

Internal components are passive, data-driven augmentations that attach to host components and apply periodic effects. Unlike regular components or equipped items, they do not participate in actions directly — their sole purpose is to modify host component stats over time.

This data model defines the structure of `data/internalComponents.json`, consumed by the `InternalComponentController`.

## Design Rationale

### Why passive and data-driven?

Internal components encapsulate stats-over-time behavior entirely in data rather than code. Adding a new periodic effect requires only a new entry in `data/internalComponents.json` — no source code changes. This aligns with the project's data-driven design principle.

### Why attach to host components rather than entities?

Internal components modify **component-level** stats (e.g., `Physical.durability` on a specific component). Attaching them to entities would apply effects globally, which is too coarse-grained. Component-level attachment enables effects that target specific parts of a multi-component entity.

### Why tick-based rather than event-based?

A unified tick system provides predictable, synchronized periodic effects across all internal components. The `InternalComponentController` manages a centralized tick counter, firing effects at configured intervals. This avoids race conditions from event-driven timing and simplifies reasoning about effect scheduling.

## Data Structure

Each entry in `data/internalComponents.json` represents a distinct internal component type:

- `volume` — physical volume occupied by this internal component
- `traits` — trait templates applied to the host component
- `tickInterval` — how often (in ticks) effects fire
- `tickEffects` — list of stat modification effects applied per tick
- `autoInstallOnSpawn` — whether this component auto-installs on eligible hosts during entity creation
- `targetBlueprintTypes` — filter: only install on entities of these blueprint types
- `requiredTraits` — filter: only install on hosts with these trait values meeting minimums
- `excludedComponentTypes` — filter: never install on these component types

### Tick Effects

Each effect in `tickEffects` defines a stat modification:

- `effect` — type of modification: `add`, `set`, or `multiply`
- `targetTrait` — trait category (e.g., `"Physical"`, `"Movement"`)
- `targetStat` — stat name within the trait (e.g., `"durability"`, `"move"`)
- `amount` — magnitude of the modification

Effect operations:

- `add` — adds `amount` to the current stat
- `set` — sets the stat to exactly `amount`
- `multiply` — multiplies the current stat by `amount`

## Auto-Installation Filters

Auto-installation uses a fail-fast pipeline that evaluates filters from low-cost to high-cost:

1. **Lifecycle check** — only types with `autoInstallOnSpawn: true` are considered
2. **Blueprint targeting** — if `targetBlueprintTypes` is set, entity must match
3. **Required traits** — if `requiredTraits` is set, host must possess those traits at sufficient levels
4. **Type exclusions** — host must not be in `excludedComponentTypes`
5. **Volume capacity** — host must have sufficient free volume
6. **Uniqueness** — host cannot receive duplicate instances of the same type

## Auto-Installation Default Change

### Why `autoInstallOnSpawn: false`?

The `autoInstallOnSpawn` flag was changed from `true` to `false` for existing components (`durabilityRepairSphere` and `transcendentSpeedCore`). Previously, all entities inherited internal components automatically, which caused unintended stat modifications on entity types not designed to support them.

Setting the default to `false` requires explicit opt-in via `InternalComponentController.addInternalComponent()`. This gives developers deliberate control over which entities receive internal components, preventing silent behavior changes when new entity types are added.

## Related

- Related wiki: `wiki/subMDs/controllers/internal_component_controller.md` — Controller that consumes this data
- Related wiki: `wiki/subMDs/data/components_and_entities.md` — Component system overview
- Related data file: `data/internalComponents.json` — Actual definitions