# 🤖 Entity Management System

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