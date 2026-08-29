# 🎮 Action System

## 1. Overview

The Action System executes game actions on entities through a registry-based, consequence-driven pipeline: validate requirements, resolve which components satisfy each requirement, and execute success or failure consequences.

**Architecture**:
- An action controller orchestrates execution
- A capability controller provides pre-computed component capabilities
- A consequence dispatcher resolves targets and dispatches to handlers
- Delegated utilities handle range validation, component resolution, and requirement resolution

Room-related actions interact with rooms via a room lookup service. Spatial movement applies delta-translation consequences. See [movement_system.md](./movement_system.md).

---

## 2. Action Registry Structure

Actions are fully data-driven: an action's behavior (targeting, range, requirements, success
effects, and optional failure effects) is defined in the registry data, not in code, so new
actions can be added without touching the pipeline.

### Mandatory Target Field

Every consequence must declare which entity it applies to — the source component, the
selected target, or the entity as a whole — because a single action can affect several
different entities, and the dispatcher must resolve each effect to one concrete target
before applying it.

---

## 3. Component Binding Resolution

The system must decide which of the actor's components actually performs the action.
Callers may name one explicitly; when they don't, the system falls back through
contextually sensible defaults — the component implied by spatial targeting, a
self-targeted component, and finally the whole entity — so actions work with minimal
caller input.

---

## 4. Consequences

### Success Consequences
Dispatched through the consequence handler system. Supported types include spatial translation, stat updates, component stat delta changes, component damage, logging, and event triggering.

### Failure Consequences
Failure consequences let an action define what happens when it fails (instead of a silent
no-op); they are handled by the same consequence pipeline as success consequences.

### Multi-Attacker Actions
Some actions process multiple attacker components separately, each dealing damage based on its own stats.

---

### Range Expressions

Ranges in action definitions can be written as expressions over an entity's stats instead of
a fixed number, so that reach can scale with the actor's characteristics (e.g. a stronger
actor has a longer reach). Expressions reuse the same placeholder mechanism that
consequences use, ensuring range, consequences, and failureConsequences all share a single
dynamic-value resolution path.

---

## 5. Public API Methods

The action controller is the single entry point for executing actions and querying what an
entity can do. Capability caching is deliberately delegated to the capability controller:
capabilities are derived data that must stay current as stats change, and giving them a
single owner keeps action execution decoupled from cache management.

---

## 6. Built-in Consequence Handlers

See [consequence_handler_architecture.md](./consequence_handler_architecture.md) for handler details.

| Handler | Responsibility |
|---------|---------------|
| Spatial | Delta movement and spatial translation |
| Stat | Direct stat and stat delta updates |
| Damage | Component health reduction |
| Log | Server-side logging |
| Event | Event triggering |

---

## 7. Placeholder Resolution

Consequence parameters can reference an entity's stats instead of fixed numbers, so that
effect magnitudes scale with the entity's characteristics and are tuned through data.

---

## 8. Interaction with Turn-Based Queuing

The action pipeline is also the resolution target for actions queued during a turn's planning window: queued entries replay through this exact pipeline (range, requirements, synergy, consequences) in initiative order at resolution. The planning window closes only on all-ready — every round-start roster planner has signaled plan-complete (a removal counts as vacuously complete; there is no deadline) — so a queue rejection for a closed window lasts until the next round starts on the next tick. Resolution semantics (replay order, full validation at replay time, failures discarded with a log rather than aborting the round) are deliberately unchanged by the barrier: the turn system owns timing and ordering only, never validation or consequences.
