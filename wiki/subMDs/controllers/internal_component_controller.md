# Internal Component Controller

## 1. Overview

The `InternalComponentController` manages the storage, lifecycle, and passive effects of internal components attached to host components on entities. It provides a data-driven system for components that apply periodic effects to their hosts without requiring individual timers.

### Architecture Pattern

Per wiki/CORE.md: InternalComponentController is a **State Controller** (data store only), following the State Ownership vs. Logic Coordination pattern.

**Why self-instantiating without DI:** As a pure state store, the controller owns entity-internal-component mappings. Self-instantiation eliminates circular dependency risks between the controller and WorldStateController, while guaranteeing state consistency — the controller never receives a partially-initialized or swapped state object, preventing desynchronization between stored component data and world state.

The controller stores *what* exists (state) but delegates *how* to modify traits to `WorldStateController`. This separation ensures internal components remain decoupled from the trait mutation pipeline.

### Storage Design

Internal components are stored nested per host component and per entity. This mirrors the physical constraint that internal components occupy volume within host components — the same nesting that models the physical constraint makes queries by host or by entity natural.

## 2. Unified Tick System

### Why a Single Unified Tick

Instead of spawning a separate `setInterval` per internal component type, the controller uses a **single 1-second interval** that drives all effects. This design was chosen because:

- **Resource efficiency**: One timer instead of N timers reduces GC pressure and scheduling overhead
- **Deterministic ordering**: All effects fire in a known, consistent sequence each second, preventing timing-dependent bugs
- **Simplified lifecycle**: One start/stop pair controls everything

Each component type declares its own cadence and effects in the data registry, and the controller applies them generically — no code changes are needed to add a new component type.

### Effect System Design

The effect system supports three operations: increment, assign, and scale. This covers the full range of stat modification intents without requiring custom effect logic per component type.

### Turn-Driven Effects (round-start channel)

Besides the tick channel, a type may opt into a **turn-driven** channel with `turnDriven: true`. Its `turnEffects` fire exactly ONCE PER ROUND, invoked by the turn system's round-start hook (wired in the composition root), rather than by the unified tick. This exists because some effects are only meaningful at round granularity: a "maintained" host stat (a `set` that overwrites rather than adds, so the bonus never stacks) or a self-durability spend of 1 per round. Driving those from the tick channel would double-apply them many times per round.

Each `turnEffects` entry carries a `target` field:

- `self` - mutate the instance's OWN stat pool (a defensive copy of the type's `traits` stored on the instance). When a `self` durability drain reaches 0, the instance is marked broken and STOPS applying effects until removed/re-installed.
- `host` - mutate the host component's stat via the world-state facade's public stat API (`set` = absolute overwrite for the maintained semantic; `add`/`multiply` = computed delta).

The tick channel and the turn channel are mutually exclusive: `_processTick` skips `turnDriven` types, and `processTurnEffects` skips non-turnDriven types, so an effect is never applied twice.

**Fail-fast validation.** Structurally invalid registry entries — a missing `targetTrait`/`targetStat`, an unknown `effect` vocabulary value, a non-numeric `amount`, or an unknown `target` — throw `TypeError` at load time so corrupted data never enters the internal state. Only genuinely optional/soft conditions (e.g. a passive no-op type with neither channel, or a missing optional volume) are surfaced as warnings. This mirrors the project rule that state controllers validate loaded data before trusting it.

## 3. Auto-Installation Design

Internal components auto-install on eligible host components during entity spawn. Auto-installation filters by:

- **Lifecycle flag**: Only types marked for auto-installation are considered
- **Blueprint targeting**: Optional targeting restricts installation to specific entity types
- **Required traits**: Optional trait requirements restrict installation to host components that expose specific stats with minimum values
- **Type exclusions**: Exclusions prevent installation on incompatible hosts
- **Volume capacity**: The host must have sufficient free volume
- **Host type / slot**: optional `hostComponentType` / `hostSlot` restrict installation to a specific limb. `hostSlot` matches the host's PARENT arm's identifier (resolved via `dependsOn[0]`), not the host's own identifier — because the blueprint expander remaps nested component identifiers with a `default_` prefix (the left hand carries `default_left`), so the data file names the limb by its arm slot instead.
- **Uniqueness**: A host cannot receive duplicate instances of the same internal component type

This filtering pipeline exists because auto-installation is a **declarative intent** — the registry says "this component should be on these hosts," and the controller resolves the actual installation at runtime.

### Filter Pipeline Rationale

The filter order follows a **fail-fast, low-cost-to-high-cost** progression. Early filters (lifecycle, blueprint targeting, required traits) reject mismatches using cheap property lookups before expensive volume calculations or uniqueness checks execute. This minimizes computational overhead during entity spawn, which occurs frequently during gameplay.

### Required Traits Filter Rationale

The required-traits filter ensures internal components only auto-install on host components that possess specific capabilities. For example, a mobility-enhancing internal component should only attach to components that define a `Movement` trait with sufficient `move` stat value. This declarative constraint eliminates the need for post-spawn validation or corrective logic — if a component lacks the required traits, the internal component simply does not install.

The filter operates at component type resolution time, checking against the global trait definitions in `data/components.json`. This decouples eligibility requirements from the component type definitions, allowing internal component constraints to evolve independently.

## 4. Instance Management

The public surface covers the full instance lifecycle: attaching and detaching components, querying instances by host or by entity, checking whether a type is present on a host, and cleaning up all of a host's instances on despawn. All queries return defensive deep copies, per the state-controller rule against external mutation of internal state.

## 5. Component Types

### `durabilityRepairSphere`

Passively heals host durability over time. Represents a self-repair nanite cluster.

### `transcendentSpeedCore` (Minor Transcendence of the God of Speed)

Increases `Movement.move` over time, auto-installs only on `smallBallDroid` entities. Demonstrates the generic tick system's extensibility.

### `strengthCore`

Turn-driven: each round it drains 1 from the HOST HAND's `Physical.durability` (`host`, `add -1`) and MAINTAINS the host hand's `Physical.strength` to 50 (`host`, a non-additive `set`). Auto-installs only on the `smallBallDroid` left `droidHand` (via `hostComponentType`/`hostSlot`). When the host hand's durability reaches 0 (driven by the per-turn drain), the instance breaks and stops applying effects. The IC's own `instanceStats` pool (the type's `traits`, e.g. `Physical.durability: 20`) is kept as a static trait for display/completeness but is NOT drained by this type — the per-turn drain targets the host hand, not the IC's own pool. Demonstrates the turn-driven channel.

## 6. Dependency Injection

The controller is self-instantiated. The world state controller is injected after initialization, enabling the tick system to modify component stats through the public API. This delayed injection prevents circular dependencies while maintaining access to the stat mutation pipeline.

## 7. Integration Points

| Point | Why |
|-------|-----|
| `WorldStateController` | Owns and starts the tick system; coordinates world-state broadcast |
| `server.js` | Triggers tick shutdown on graceful shutdown |
| `stateEntityController` | Requests auto-installation during entity creation |
