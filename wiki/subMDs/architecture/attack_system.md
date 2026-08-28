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

## Data Schema

Component-targeted attacks declare everything they do — range, requirements, and
consequences — entirely in data, so the unified handler can execute any of them without
per-action code.

## Adding New Attack Types

Adding a new component-targeted attack requires only a new entry in `data/actions.json` with the appropriate `targetingType`, `range`, `requirements`, and `consequences`. No frontend code changes are needed.

## Related

- [Action System](architecture/action_system.md) — Overall action pipeline
- [Client Action Execution](frontend/client_action_execution.md) — Client action flow
