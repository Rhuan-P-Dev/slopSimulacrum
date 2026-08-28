# Components and Entities

## 1. Overview

Entities are composed of components, which may contain internal components. Blueprints define the entity hierarchy and component structure.

## 2. Entity vs Component

| Aspect | Entity | Component |
|--------|--------|-----------|
| Identity | Unique ID per instance | Unique ID per instance |
| Blueprint | Has an associated blueprint | Defined in the component registry |
| Location | Has a location (room) | No location |
| Composition | Contains components | May contain internal components |
| Spatial | Position relative to room | Position relative to entity |

### Internal Components

Internal components attach to specific host components rather than to the entity as a whole, so their effects target specific parts of a multi-component entity. They are auto-installed on entity spawn when a host has sufficient volume capacity and is not excluded by type.

## 3. Volume-Based Capacity Model

Internal components consume volume on their host component. This model exists because:

- **Physical constraint simulation**: Real components have finite space; internal components must fit within host boundaries
- **Balance through scarcity**: Volume limits prevent unlimited internal component stacking, forcing meaningful trade-offs during entity construction
- **Exclusion-based flexibility**: Specific component types can be excluded from receiving certain internal components, representing physical or logical incompatibilities

### Dual Constraint System: Volume + Traits

Internal component installation uses a **dual constraint system** to determine whether a component can attach to a host:

| Constraint | Purpose | Definition |
|------------|---------|------------|
| **Volume** | Physical/space capacity | Hosts have finite space; the internal component must physically fit inside it |
| **Traits** | Capability compatibility | The host must be a component type that can meaningfully benefit from the internal component |

The volume constraint ensures physical fit; the trait constraint ensures capability compatibility. Both must pass for auto-installation to succeed. This dual system provides two independent axes of control: space limits prevent stacking abuse, while trait requirements ensure internal components only attach to components that can meaningfully benefit from them.

## 4. Architecture

Injection follows a bottom-up chain from state controllers up to logic controllers.

## 5. Entity Lifecycle

Entities have exactly two lifecycle transitions — spawn and despawn — and the surrounding concerns (internal component installation, T1 weapon auto-assignment, capability re-evaluation, state cleanup) are folded into those transitions automatically so blueprints never have to script per-entity setup.

### T1 Weapon Auto-Assignment

Entities spawned from blueprints that include components with sufficient volume automatically receive a T1 container weapon. The assignment prioritizes hand components for natural positioning and falls back to any component with available space. This ensures all compatible entities begin with the T1 without explicit blueprint configuration.

See [T1 Weapon System](../systems/t1_weapon_system.md) for full details on the container weapon concept.

## 6. Blueprint Hierarchy

Blueprints are resolved bottom-up — leaf components before their parents — because a parent's final traits must accumulate contributions from all of its children in a deterministic order.

## 7. Data Models

The internal component store supports two query axes — by owning entity and by individual host component — because entity-wide concerns (spawn installation, capability evaluation) and host-scoped concerns (attachment, cleanup on despawn) both need to look components up.