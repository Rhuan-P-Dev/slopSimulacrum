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

### Why a turn-driven channel exists alongside the tick channel?

Some effects are meaningful only at TURN granularity, not wall-clock ticks: a component that "maintains" a host stat to a fixed value each round, or one that drains the HOST HAND's durability once per round. Driving those from the tick channel would double-apply them (the tick fires many times per round) and would couple round-level game pacing to the wall-clock tick rate. The `turnDriven` flag opts a type into the ROUND-START channel instead: its `turnEffects` fire exactly once per round, via the turn-start hook, so a "maintained" bonus is naturally non-additive and a host-hand durability drain is exactly 1 per round. A type is either tick-driven or turn-driven, never both.

The `strengthCore` type illustrates the host-targeting semantic: its per-turn drain hits the host hand's `Physical.durability` (the droid's left hand), not the IC's own pool. When that host-hand durability reaches 0, the instance breaks and stops applying effects — the component is destroyed with its host limb. The IC's own `instanceStats` pool (the type's `traits`) is retained as a static trait for display/completeness but is not drained by this type.

### Why does the coal generator burn discrete fuel items instead of emitting a continuous drain?

The `consumeFuelGenerateStat` effect converts the droid's carried fuel items into a resource stat in whole, discrete units rather than draining a continuous amount. Discrete consumption ties generator output to the droid's actual inventory contents — it can never charge from fuel it does not carry — and keeps the charge an exact multiple of the per-fuel gain for the life of the droid, so the "1 fuel = N energy" balance lever stays exact and testable. It also makes runout an observable, loggable transition (a single warning on the way into the dry state) instead of a silent rate drop, and degrades gracefully: with no fuel aboard the generator simply idles without touching any other stat.

## Data Model

Each entry in `data/internalComponents.json` describes one internal component type conceptually: what it does to a host (the traits it applies and the periodic effects it schedules) and where it may live (its volume cost and the eligibility filters that gate auto-installation).

## Auto-Installation Filters

A type auto-installs on a host only if it passes every eligibility gate:

- **Opt-in**: the type is marked for spawn-time installation
- **Blueprint targeting**: the entity's blueprint type is allowed
- **Required traits**: the host possesses the required traits at sufficient levels
- **Type exclusions**: the host's component type is not excluded
- **Volume capacity**: the host has enough free volume
- **Host type / slot**: the host is the declared component type and (optionally) the declared slot
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
