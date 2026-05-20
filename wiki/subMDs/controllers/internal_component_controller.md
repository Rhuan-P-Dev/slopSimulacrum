# Internal Component Controller

## 1. Overview

The `InternalComponentController` manages the storage, lifecycle, and passive effects of internal components attached to host components on entities. It provides a data-driven system for components that apply periodic effects to their hosts without requiring individual timers.

### Architecture Pattern

Per wiki/CORE.md: InternalComponentController is a **State Controller** (data store only), following the State Ownership vs. Logic Coordination pattern.

**Why self-instantiating without DI:** As a pure state store, the controller owns entity-internal-component mappings. Self-instantiation eliminates circular dependency risks between the controller and WorldStateController, while guaranteeing state consistency — the controller never receives a partially-initialized or swapped state object, preventing desynchronization between stored component data and world state.

The controller stores *what* exists (state) but delegates *how* to modify traits to `WorldStateController`. This separation ensures internal components remain decoupled from the trait mutation pipeline.

### Storage Design

Internal components are stored as a nested mapping: entity → host component → list of instances. This structure mirrors the physical constraint that internal components occupy volume within host components, making it natural to query by host or by entity.

## 2. Unified Tick System

### Why a Single Unified Tick

Instead of spawning a separate `setInterval` per internal component type, the controller uses a **single 1-second interval** that drives all effects. This design was chosen because:

- **Resource efficiency**: One timer instead of N timers reduces GC pressure and scheduling overhead
- **Deterministic ordering**: All effects fire in a known, consistent sequence each second, preventing timing-dependent bugs
- **Simplified lifecycle**: One `startTickSystem()` / `stopTickSystem()` pair controls everything

Each component type defines its own `tickInterval` and `tickEffects` in the registry (`data/internalComponents.json`). The controller reads the registry and applies effects generically — no code changes are needed to add a new component type.

### Effect System Design

The effect system supports three operations: increment (`add`), assign (`set`), and scale (`multiply`). This covers the full range of stat modification intents without requiring custom effect logic per component type.

## 3. Auto-Installation Design

Internal components auto-install on eligible host components during entity spawn. Auto-installation filters by:

- **Lifecycle flag**: Only types with `autoInstallOnSpawn` are considered
- **Blueprint targeting**: Optional `targetBlueprintTypes` restricts installation to specific entity types
- **Required traits**: Optional `requiredTraits` restricts installation to host components that expose specific stats with minimum values
- **Type exclusions**: `excludedComponentTypes` prevents installation on incompatible hosts
- **Volume capacity**: The host must have sufficient free volume
- **Uniqueness**: A host cannot receive duplicate instances of the same internal component type

This filtering pipeline exists because auto-installation is a **declarative intent** — the registry says "this component should be on these hosts," and the controller resolves the actual installation at runtime.

### Filter Pipeline Rationale

The filter order follows a **fail-fast, low-cost-to-high-cost** progression. Early filters (lifecycle, blueprint targeting, required traits) reject mismatches using cheap property lookups before expensive volume calculations or uniqueness checks execute. This minimizes computational overhead during entity spawn, which occurs frequently during gameplay.

### Required Traits Filter Rationale

The `requiredTraits` filter ensures internal components only auto-install on host components that possess specific capabilities. For example, a mobility-enhancing internal component should only attach to components that define a `Movement` trait with sufficient `move` stat value. This declarative constraint eliminates the need for post-spawn validation or corrective logic — if a component lacks the required traits, the internal component simply does not install.

The filter operates at component type resolution time, checking against `data/components.json` trait definitions. This decouples eligibility requirements from the component type definitions, allowing internal component constraints to evolve independently.

## 4. Instance Management

| Method | Purpose |
|--------|---------|
| `addInternalComponent` | Manually attach a component |
| `removeInternalComponent` | Detach a specific instance |
| `getInternalComponents` | Query by host (deep copy) |
| `getInternalComponentsForEntity` | Query by entity (deep copy) |
| `hasInternalComponent` | Type presence check |
| `cleanupEntity` | Resource cleanup on despawn |
| `getAll` | Full state snapshot (deep copy) |

## 5. Component Types

### `durabilityRepairSphere`

Passively heals host durability over time. Represents a self-repair nanite cluster.

### `transcendentSpeedCore` (Minor Transcendence of the God of Speed)

Increases `Movement.move` over time, auto-installs only on `smallBallDroid` entities. Demonstrates the generic tick system's extensibility.

## 6. Dependency Injection

The controller is self-instantiated. The `worldStateController` is injected after initialization via `setWorldStateController()`, enabling the tick system to modify component stats through the public API. This delayed injection prevents circular dependencies while maintaining access to the stat mutation pipeline.

## 7. Integration Points

| Point | Why |
|-------|-----|
| `WorldStateController` | Owns and starts the tick system; coordinates world-state broadcast |
| `server.js` | Triggers `stopTickSystem()` on graceful shutdown |
| `stateEntityController` | Calls `autoInstallOnEntitySpawn()` during entity creation |