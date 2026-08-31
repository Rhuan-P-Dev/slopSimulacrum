# Controller Patterns and Dependency Management

## 1. Overview

All controllers use **Dependency Injection** rather than internal instantiation of other controllers. This maintains a single source of truth and prevents state desynchronization.

**Exception**: **State Controllers** that hold raw data and have no cross-controller dependencies self-instantiate. See wiki/CORE.md.

## 2. Why Dependency Injection Is Mandatory

DI is enforced because:

- **Single source of truth**: When the root controller wires all dependencies, every controller references the same state objects. Internal instantiation creates duplicate state — the #1 cause of desynchronization bugs.
- **Testability**: Controllers can be tested in isolation by injecting mock dependencies.
- **Explicit contracts**: Dependencies listed in the constructor define the controller's interface — no hidden dependencies.

## 3. Root Injector Pattern

A single root controller (`WorldStateController`) is responsible for all controller instantiation. It wires everything in a bottom-up order, from leaf state controllers up to coordinating logic controllers. This exists because:

- **Lifecycle clarity**: One controller owns the creation and destruction of all others
- **Dependency ordering**: Leaf controllers are ready before dependents are wired
- **Debuggability**: The dependency graph is visible in one place

## 4. State Controllers vs. Logic Controllers

| Type | DI? | Purpose |
|------|-----|---------|
| **State Controller** | Self-instantiates (no DI) | Data storage, raw data access |
| **Logic Controller** | Uses DI | Computation, coordination, game logic |

**Why this distinction**: State Controllers own data — injecting state creates circular dependencies. Logic Controllers need access to state — injection provides it without coupling.

## 5. Communication Protocol

Use **public methods only** — never access another controller's private or internal fields. Communication flows through the root controller to maintain loose coupling and the Single Source of Truth principle.

### WorldStateController Public API

The root controller exposes a public API covering entity lifecycle (spawn, despawn, move), room identity resolution, and world graph queries. It is the sole sanctioned interface for reading or mutating world state from outside the controller hierarchy, keeping the dependency graph explicit and the single source of truth intact. Payload-bearing facade getters degrade to a total empty shape — never `null` — when their backing sub-controller is unwired, so clients can render empty states instead of error states on a wiring miss; the crafting and knowledge getters are the two current instances of the rule.

## 6. Controller Roles

### ActionController — Action Execution Coordinator

Coordinates action execution, delegates capability cache queries to the capability controller, and synergy computation to the synergy controller.

### ComponentCapabilityController — Capability Cache Manager

Responsible for scanning, scoring, caching, and re-evaluating component capabilities. Subscribes to stat change events from the component controller for efficient incremental re-evaluation.

## 7. Defensive Copying

State Controllers that expose data via public methods must return **defensive deep copies** to prevent external mutation of internal state. This exists because JavaScript passes objects by reference — without copying, any consumer can corrupt the controller's data.

## 8. Utility Classes

Utility classes take raw data directly as constructor arguments and are instantiated on-demand. They do not use dependency injection because they are stateless functions — there is no state to synchronize.