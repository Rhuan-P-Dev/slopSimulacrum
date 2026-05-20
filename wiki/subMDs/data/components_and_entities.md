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

Entities store internal components keyed by host component ID. These are auto-installed on entity spawn based on volume capacity and type exclusions.

## 3. Volume-Based Capacity Model

Internal components consume volume on their host component. This model exists because:

- **Physical constraint simulation**: Real components have finite space; internal components must fit within host boundaries
- **Balance through scarcity**: Volume limits prevent unlimited internal component stacking, forcing meaningful trade-offs during entity construction
- **Exclusion-based flexibility**: Specific component types can be excluded from receiving certain internal components, representing physical or logical incompatibilities

## 4. Architecture

Injection follows a bottom-up chain from state controllers up to logic controllers.

## 5. Entity Lifecycle

| Method | Description |
|--------|-------------|
| `spawnEntity` | Create entity from blueprint, auto-install internal components, re-evaluate capabilities |
| `despawnEntity` | Remove entity, clean up state, re-evaluate capabilities |

## 6. Blueprint Hierarchy

Blueprints are processed bottom-up: leaf components are created first, then parents. This ensures trait merges accumulate in the correct order.

## 7. Internal Component API

The `InternalComponentController` provides these public methods:

| Method | Purpose |
|--------|---------|
| `addInternalComponent` | Manually attach a component |
| `removeInternalComponent` | Detach a specific instance |
| `getInternalComponents` | Query by host (deep copy) |
| `getInternalComponentsForEntity` | Query by entity (deep copy) |
| `hasInternalComponent` | Type presence check |
| `cleanupEntity` | Resource cleanup on despawn |
| `startTickSystem` / `stopTickSystem` | Unified tick interval control |
| `setWorldStateController` | DI setter (called after init) |

## 8. Data Models

Internal components are stored in a nested structure keyed by entity ID and host component ID, enabling efficient lookup by both entity and individual host.

## 9. API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/internal-components/registry` | All type definitions |
| GET | `/api/internal-components/:entityId` | All components for entity |
| GET | `/api/internal-components/:entityId/:hostId` | Components for host |
| POST | `/api/internal-components/:entityId/:hostId/add` | Add component |
| DELETE | `/api/internal-components/:entityId/:hostId/:icId` | Remove component |