# Internal Components Data Model

## Purpose

Internal components are passive, data-driven augmentations that attach to host components and apply periodic effects. Unlike regular components or equipped items, they do not participate in actions directly — their sole purpose is to modify host component stats over time.

`data/internalComponents.json` declares the available internal component types — what each type does to a host and where it is allowed to live — and is consumed by the `InternalComponentController`.

## Design Rationale

### Why passive and data-driven?

Internal components encapsulate stats-over-time behavior entirely in data rather than code. Adding a new periodic effect requires only a new entry in `data/internalComponents.json` — no source code changes. This aligns with the project's data-driven design principle.

### Why attach to host components rather than entities?

Internal components modify **component-level** stats (e.g., `Physical.durability` on a specific component). Attaching them to entities would apply effects globally, which is too coarse-grained. Component-level attachment enables effects that target specific parts of a multi-component entity.

### Why round-driven (per-turn) rather than event-based?

> **SUPERSEDED by [turn_driven_ic_and_flow_spec.md](wiki/turn_driven_ic_and_flow_spec.md)** — effects now fire at round start via the turn-start hook, not on a wall-clock tick.

A round-driven (per-turn) channel provides predictable, synchronized periodic effects across all internal components, avoiding race conditions from event-driven timing and simplifying reasoning about effect scheduling. The cadence is per-round (gated on the round number), decoupled from any tick rate.

### Why a round-start (per-turn) channel rather than a wall-clock tick?

The periodic effects live in the `overTime` channel and fire at **round start** (the turn-start hook), not on a wall-clock tick. This keeps round-level game pacing decoupled from the tick rate: an effect that should happen "every N rounds" is expressed directly by its `intervalTurns` (the round gate is `round > 0 && round % intervalTurns === 0`), with no per-instance state and no double-application. A type is either periodic (a non-empty `overTime` list) or passive (an empty list — e.g. `strengthCore`), and the cadence is per-round, not per-tick.

The `repairSphere` and `corrosiveGland` organs are the shipped periodic cases: the repair organ closes the salvage→existence loop, the corrosive organ degrades neighbors through the corrosion channel. The `coalGenerator` organ still ships (auto-installed on `m1CentralBody` for recipe compatibility) but is now **inert** — empty `overTime` and empty `grants`: it consumes no coal and grants no energy, because the energy mechanic was removed from the data. A broken instance or broken host stops its effects for the duration.

### Why does the coal generator burn discrete fuel items instead of emitting a continuous drain?

> **SUPERSEDED by data change** — the energy mechanic was removed from the shipped data: the `coalGenerator` organ no longer declares a `consumeFuelGenerateStat` effect (its `overTime` is empty), so there is nothing to burn. The paragraph below is kept as design history; the current contract (inert organ) is pinned by `test/contract/coalGenerator.contract.test.js`.

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
