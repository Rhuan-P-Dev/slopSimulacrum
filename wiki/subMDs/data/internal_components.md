# Internal Components Data Model

## Purpose

Internal components are passive, data-driven augmentations that attach to host components and apply periodic effects. Unlike regular components or equipped items, they do not participate in actions directly — their sole purpose is to modify host component stats over time.

`data/internalComponents.json` declares the available internal component types — what each type does to a host and where it is allowed to live — and is consumed by the `InternalComponentController`.

## Design Rationale

### Why passive and data-driven?

Internal components encapsulate stats-over-time behavior entirely in data rather than code. Adding a new periodic effect requires only a new entry in `data/internalComponents.json` — no source code changes. This aligns with the project's data-driven design principle.

### Why attach to host components rather than entities?

Internal components modify **component-level** stats (e.g., `Physical.durability` on a specific component). Attaching them to entities would apply effects globally, which is too coarse-grained. Component-level attachment enables effects that target specific parts of a multi-component entity.

### Why tick-based rather than event-based?

A unified tick system provides predictable, synchronized periodic effects across all internal components, avoiding race conditions from event-driven timing and simplifying reasoning about effect scheduling.

## Data Model

Each entry in `data/internalComponents.json` describes one internal component type conceptually: what it does to a host (the traits it applies and the periodic effects it schedules) and where it may live (its volume cost and the eligibility filters that gate auto-installation).

## Auto-Installation Filters

A type auto-installs on a host only if it passes every eligibility gate:

- **Opt-in**: the type is marked for spawn-time installation
- **Blueprint targeting**: the entity's blueprint type is allowed
- **Required traits**: the host possesses the required traits at sufficient levels
- **Type exclusions**: the host's component type is not excluded
- **Volume capacity**: the host has enough free volume
- **Uniqueness**: the host does not already carry that type

The checks are ordered from cheap to expensive so that ineligible hosts fail fast without the costlier capacity work.

## Auto-Installation Default Change

### Why `autoInstallOnSpawn: false`?

The `autoInstallOnSpawn` flag was changed from `true` to `false` for existing components (`durabilityRepairSphere` and `transcendentSpeedCore`). Previously, all entities inherited internal components automatically, which caused unintended stat modifications on entity types not designed to support them.

Setting the default to `false` requires explicit opt-in at runtime for each installation. This gives developers deliberate control over which entities receive internal components, preventing silent behavior changes when new entity types are added.

## Related

- Related wiki: `wiki/subMDs/controllers/internal_component_controller.md` — Controller that consumes this data
- Related wiki: `wiki/subMDs/data/components_and_entities.md` — Component system overview
- Related data file: `data/internalComponents.json` — Actual definitions
