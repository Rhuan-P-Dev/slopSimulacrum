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

> The original per-tick cadence is retired: effects now fire at round start via the turn-start hook, not on a wall-clock tick.

A round-driven (per-turn) channel provides predictable, synchronized periodic effects across all internal components, avoiding race conditions from event-driven timing and simplifying reasoning about effect scheduling. The cadence is per-round (gated on the round number), decoupled from any tick rate.

### Why a round-start (per-turn) channel rather than a wall-clock tick?

The periodic effects live in the `overTime` channel and fire at **round start** (the turn-start hook), not on a wall-clock tick. This keeps round-level game pacing decoupled from the tick rate: an effect that should happen "every N rounds" is expressed directly by its `intervalTurns` (the round gate is `round > 0 && round % intervalTurns === 0`), with no per-instance state and no double-application. A type is either periodic (a non-empty `overTime` list) or passive (an empty list — e.g. `strengthCore`), and the cadence is per-round, not per-tick.

The `repairSphere` and `corrosiveGland` organs are the shipped periodic cases: the repair organ closes the salvage→existence loop, the corrosive organ degrades neighbors through the corrosion channel. The `knifeGeneratorIC` organ is the third shipped periodic case — a **fuel-free item producer** that fills its host component's inventory with new item instances each round and, once the host is at capacity, sheds the overflow onto the floor around it (§ The `generateItem` effect). The `coalGenerator` organ still ships (auto-installed on `m1CentralBody` for recipe compatibility) but is now **inert** — empty `overTime` and empty `grants`: it consumes no coal and grants no energy, because the energy mechanic was removed from the data. A broken instance or broken host stops its effects for the duration.

### Why does the coal generator burn discrete fuel items instead of emitting a continuous drain?

> **SUPERSEDED by data change** — the energy mechanic was removed from the shipped data: the `coalGenerator` organ no longer declares a `consumeFuelGenerateStat` effect (its `overTime` is empty), so there is nothing to burn. The paragraph below is kept as design history; the current contract (inert organ) is pinned by `test/contract/coalGenerator.contract.test.js`.

### The `generateItem` effect (fuel-free item production)

The `generateItem` overTime effect is the mirror-image of the (superseded) `consumeFuelGenerateStat`: instead of burning carried fuel to charge a stat, it **creates new item instances with no input** — one per `intervalTurns` round, or a configured count via `itemsPerInterval` (`itemKey` names the item to produce). It is the only shipped effect that *produces* matter rather than consuming or transferring it, and it has no fuel gate: the organ runs as long as its host entity is alive, which is what makes the source "infinite."

Each fire first tries to **occupy host volume** through the ordinary `addItemToEntity` path (the same public API a player uses to drop an item into a component). The host's bounded capacity comes from the component's `traits.Physical.volume` (the inventory capacity the `InventoryManager` reads); when the new item's footprint would push the host over its cap, the addition fails and the overflow is **shed onto the floor** around the host's spatial origin, in the host's room, using the same `writeDroppedItem` + `sampleDiskPoint` disk the knife-drop trigger and the material-chunk consequences use. So "around it" is not a special effect — it is the shared drop-to-floor geometry, and the fill→overflow transition is a natural consequence of the inventory volume check rather than a separate counter.

The shipped `knifeGeneratorIC` (auto-installed on the `generatorCore` host of the `knifeGenerator` static prop; `intervalTurns: 1`, `itemKey: "knife"`, 10-slot host capacity) is the concrete case: a 100%-iron prop that stores up to ten knives and then drips the surplus onto the ground beside it. A broken host stops producing (the organ's effects stop with its host, as with every organ). The contract is pinned by `test/contract/knifeGenerator.contract.test.js`.

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
