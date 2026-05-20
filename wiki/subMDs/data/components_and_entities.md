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

## 3. Architecture

Injection follows a bottom-up chain from state controllers up to logic controllers.

## 4. Entity Lifecycle

| Method | Description |
|--------|-------------|
| `spawnEntity` | Create entity from blueprint, auto-install internal components, re-evaluate capabilities |
| `despawnEntity` | Cleanup capabilities and internal components, remove entity |
| `moveEntity` | Update entity location to a new room |
| `getEntity` | Retrieve entity by ID |
| `updateEntitySpatial` | Update spatial coordinates |

**Spatial coordinates**: Screen position is computed from the room origin, the entity spatial offset, and the component's spatial offset within the entity.

---

# Internal Components System

## 1. Overview

The Internal Components system allows components to contain other components internally, using a **volume-based capacity model**. Internal components auto-install on eligible host components and provide ongoing repair effects.

## 2. Data Model

Internal components are stored in a nested structure keyed by entity ID and host component ID. Each instance tracks its type, host component reference, and installation timestamp.

### Volume System

Internal components are installed only when the host component's volume meets the required threshold AND the host type is not in the exclusions list.

### Repair Component

The repair-type internal component has its own traits separate from its repair behavior. The repair amount and repair interval properties define the host repair behavior — these are independently applied at the repair interval, not merged into host component stats.

### Volume Checking Scope

Volume validation is enforced only during auto-installation on entity spawn. Manual installation skips volume checks.

## 3. Server-Side Repair System

A repair system runs at a fixed interval. Each tick, it iterates all entities' internal components, filters for repair-type components, applies durability updates to hosts, and syncs back to the entity store for world-state broadcast.

### Public API

| Method | Returns | Description |
|--------|---------|-------------|
| `autoInstallOnEntitySpawn` | installed array | Auto-install on spawn with volume + exclusions |
| `addInternalComponent` | added component or null | Manual add |
| `removeInternalComponent` | success boolean | Remove a specific instance |
| `getInternalComponents` | defensive copy | Get components for a host |
| `getInternalComponentsForEntity` | defensive copy | Get all for an entity |
| `hasInternalComponent` | boolean | Check type presence |
| `cleanupEntity` | boolean | Cleanup on despawn |
| `startRepairSystem` / `stopRepairSystem` | void | Repair interval control |
| `setWorldStateController` | void | DI setter (called after init) |

## 4. API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/internal-components/registry` | All type definitions |
| GET | `/api/internal-components/:entityId` | All components for entity |
| GET | `/api/internal-components/:entityId/:hostId` | Components for host |
| POST | `/api/internal-components/:entityId/:hostId/add` | Add component |
| DELETE | `/api/internal-components/:entityId/:hostId/:icId` | Remove component |

## 5. Client-Side Rendering

The Component Viewer module provides an expand button per component with internal components. Clicking expands a panel showing type badge, description, host info, and metadata. Data flows from the world state's internal components field.