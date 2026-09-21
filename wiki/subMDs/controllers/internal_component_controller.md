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

> The per-tick IC job is retired; overTime effects now run once per **ROUND START** via the turn-start hook, gated on the round number. The text below describes the retired unified-tick design.

### Why a Single Unified Tick (retired)

Instead of spawning a separate `setInterval` per internal component type, the controller used a **single 1-second interval** that drove all effects. That design was chosen because:

- **Resource efficiency**: One timer instead of N timers reduces GC pressure and scheduling overhead
- **Deterministic ordering**: All effects fire in a known, consistent sequence each second, preventing timing-dependent bugs
- **Simplified lifecycle**: One start/stop pair controls everything

Each component type declares its own cadence and effects in the data registry, and the controller applies them generically — no code changes are needed to add a new component type.

### Effect System Design

The effect system supports three operations: increment, assign, and scale. This covers the full range of stat modification intents without requiring custom effect logic per component type.

### OverTime Effects (round-start channel)

The unified `overTime` channel is the single channel for all periodic effects, and it fires at **round start** through the turn system's round-start hook (wired in the composition root) — not on a wall-clock tick. Each `overTime` entry carries its own `intervalTurns` (a positive integer, unit: rounds) and is gated globally: it fires only when `round > 0 && round % intervalTurns === 0`. This gives round-granular pacing with no coupling to a tick rate, and expresses "every N rounds" directly in the data (no per-instance state).

Each `overTime` entry is one of four effect types — `restoreExistence` (reconstitute the host's existence from salvage), `emitChannelDamage` (degrade nearby components through a damage channel), `consumeFuelGenerateStat` (burn carried fuel to charge a stat), or `generateItem` (produce new item instances into the host's inventory; when the host is at capacity the overflow sheds to the floor around the host) — and the controller dispatches to the matching handler. A broken instance or broken host stops its effects. After any change the controller syncs the entity store.

**Fail-fast validation.** Structurally invalid registry entries — a missing or non-positive-integer `intervalTurns`, an unknown effect type, a missing field required by the effect type, or a non-numeric amount — throw `TypeError` at load time so corrupted data never enters the internal state. Only genuinely optional/soft conditions (e.g. a passive type with an empty `overTime` list, or a missing optional volume) are surfaced as warnings. This mirrors the project rule that state controllers validate loaded data before trusting it.

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

Increases `Movement.move` over time, auto-installs only on `smallBallDroid` entities. Demonstrates the per-turn overTime channel's extensibility (a new effect type is a registry entry plus one handler — no new job needed).

### `strengthCore`

A pure *function* organ: it *maintains* the host limb's `Physical.strength` at a granted level — a static, non-additive set, so installing (or re-installing) it keeps strength at the granted value rather than stacking it. It carries **no** over-time behavior (no per-round drain, no break condition), because its only role is to hold one static capability. That capability is a data-driven grant: the type default, or a per-recipe override (a heavier rolling ball ships a stronger `strengthCore`). It is a declared organ (its host types list it in their `internalComponents`), so the *recipe* — not the code — decides which value is granted on each build.

## 6. Dependency Injection

The controller is self-instantiated. The world state controller is injected after initialization, enabling the round-start hook to modify component stats through the public API. This delayed injection prevents circular dependencies while maintaining access to the stat mutation pipeline.

## 7. Integration Points

| Point | Why |
|-------|-----|
| `WorldStateController` | Owns and starts the tick system; coordinates world-state broadcast |
| `server.js` | Triggers tick shutdown on graceful shutdown |
| `stateEntityController` | Requests auto-installation during entity creation |
