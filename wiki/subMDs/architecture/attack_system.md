# Attack System Architecture

## Overview

The attack system provides a **generic, data-driven handler** for all component-targeted actions. Any action with `targetingType: 'component'` in `data/actions.json` automatically uses the unified frontend handler, enabling new attack types to be added purely through data configuration.

## Why a Unified Handler

Previously, the frontend maintained hardcoded, action-name-specific handlers (`executePunch`, `executeCut`). This violated the Single Responsibility Principle and created several problems:

1. **Frontend coupling to action names** — adding a new attack type required modifying frontend code, violating data-driven design
2. **Logic duplication** — range validation, entity resolution, and component selection were duplicated across handlers
3. **Fragile extensibility** — any change to shared logic (e.g., range calculation, error handling) had to be replicated across all handlers

The unified handler decouples the frontend from specific action names by reading `targetingType` and `range` from the action definition at runtime.

## Design Decisions

### Single Routing Point

The `EventDispatcher` acts as the single routing entry point for all component-targeted actions. Instead of checking for specific action names, it delegates to a generic `executeComponentAttack` handler registered in the handlers registry. This ensures that the dispatcher has no knowledge of individual action types.

### Action-Name Agnostic Execution

The `ActionExecutor` handler operates solely on the `targetingType` and `range` properties from the action definition. It does not inspect the action name, meaning any future action with `targetingType: 'component'` is automatically supported without code changes.

### Expression-Based Range Resolution

Range can be defined as either a static numeric value or a dynamic expression in `data/actions.json`. Expression-based ranges enable attacks whose reach scales with the entity's stats (e.g., a stronger character having a longer reach). This decouples range logic from hardcoded values and allows designers to tune behavior through data.

### Multi-Attacker Synergy Support

The handler supports selecting multiple attacker components simultaneously, delegating to a batch execution path on the server. This enables cooperative attacks where multiple components contribute damage independently, with synergy computed server-side.

### Backend Separation

The backend consequence system remains fully data-driven. The action's `consequences` array in `data/actions.json` determines all effects — damage calculation, targeting, and logging — with no frontend involvement. The frontend's role is limited to selecting targets and dispatching the action; the backend owns all game logic.

## Attacker-Material Channel Split

Channel-damage actions (punch, cut, shootT1) converge on one backend choke point, and the **attacker's** material decides how a hit's raw value is distributed across the damage channels. A wooden fist blunts and shreds; an iron fist is pure impact — so the channel mix is a property of the *attacking* object, resolved from its composition, while the target resists each resulting channel slice on its own.

The split is applied at that single choke point rather than per action, which keeps the unified, action-name-agnostic handler generic: any current or future `targetingType: 'component'` attack that deals channel damage inherits material-aware splitting without per-action code, and the legacy trait/stat path (no channel) is left untouched for back-compat. See [Material Damage & Chunk Drop](../data/material_damage_and_drop.md) for the rationale.

## Data Schema

Component-targeted attacks declare everything they do — range, requirements, and
consequences — entirely in data, so the unified handler can execute any of them without
per-action code.

## Adding New Attack Types

Adding a new component-targeted attack requires only a new entry in `data/actions.json` with the appropriate `targetingType`, `range`, `requirements`, and `consequences`. No frontend code changes are needed.

## Related

- [Action System](architecture/action_system.md) — Overall action pipeline
- [Client Action Execution](frontend/client_action_execution.md) — Client action flow
