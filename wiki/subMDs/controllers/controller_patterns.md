# 🛠️ Controller Patterns and Dependency Management

## 1. Overview

All controllers must use **Dependency Injection** rather than internal instantiation of other controllers, to maintain a single source of truth throughout the system.

**Exception**: **State Controllers** that hold raw data and have no cross-controller dependencies self-instantiate.

## 2. Dependency Injection Standard

Dependencies are accepted via constructor parameters. No controller creates another controller internally with direct instantiation.

## 3. Root Injector Pattern

A single root controller is responsible for all controller instantiation. It wires everything in a bottom-up order, from leaf state controllers up to coordinating logic controllers.

## 4. State Controllers vs. Logic Controllers

| Type | DI? | Purpose |
|------|-----|---------|
| **State Controller** | Self-instantiates (no DI) | Data storage, raw data access |
| **Logic Controller** | Uses DI | Computation, coordination, game logic |

**Rule**: State Controllers store data and have zero cross-controller dependencies. Logic Controllers receive dependencies via injection.

📖 Full RoomsController docs: [rooms_controller.md](./rooms_controller.md)

## 5. Communication Protocol

Use **public methods only** — never access another controller's private or internal fields. Communication flows through the root controller down to dependency controllers.

## 5.1. WorldStateController Public API

The WorldStateController provides public API wrapper methods that the server uses instead of directly accessing sub-controllers. This maintains loose coupling and the Single Source of Truth principle.

**Available Public Methods:**

| Method | Returns | Description |
|--------|---------|-------------|
| `spawnEntity` | entity ID | Creates an entity from a blueprint |
| `despawnEntity` | success boolean | Removes an entity and cleans up |
| `moveEntity` | success boolean | Moves entity to a different room |
| `getRoomUidByLogicalId` | room UUID | Resolves a logical name to its UUID |
| `getWorldGraph` | graph object | Returns the world graph with resolved room names |

## 6. ActionController Pattern

### 6.1. Role

The ActionController is an **Action Execution Coordinator**. It delegates capability cache queries to the capability controller and synergy computation to the synergy controller.

### 6.2. Constructor Injection Pattern

All dependencies are passed via constructor parameters, including the world state controller, consequence handlers, action registry, capability controller, synergy controller, and selection controller.

### 6.3. Component Lock Tracking

The action execution method tracks locked components and releases them after completion. Spatial actions track components differently from non-spatial actions based on how the source component is resolved.

### 6.4. Component Binding Resolution Priority

Components are resolved through a priority chain: explicit attacker component, explicit target component, auto-detection of spatial components, auto-detection of self-targeting components, and finally entity-wide fallback.

## 7. ComponentCapabilityController Pattern

### 7.1. Role

The **Capability Cache Manager** — responsible for scanning, scoring, caching, and re-evaluating component capabilities.

### 7.2. Stat Change Listener Integration

The controller subscribes to stat change events from the component controller. A reverse index maps trait-stat combinations to dependent actions, enabling efficient incremental re-evaluation.

## 8. State Controller Defensive Copying

State Controllers that expose data via public methods must return **defensive deep copies** to prevent external mutation of internal state.

## 9. Utility Classes

Utility classes take raw data directly as constructor arguments and are instantiated on-demand. They do not use dependency injection. Results are returned as defensive deep copies.

## 10. Client-Side Callback Patterns

Connection click callbacks flow through the UI layer, then to the room connection renderer, and finally to the world map view. Invisible hit-area elements enable reliable click detection on thin visual connections.