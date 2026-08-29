# Client-Side Action Execution

## 1. Overview

Action execution flows from user input through the server to a broadcast refresh. The server is the authority — the client never mutates game state directly.

## 2. Why Action Execution Is Asynchronous

Actions are sent to the server for validation because:

- **Server authority**: The server holds the single source of truth for entity state, room connectivity, and action requirements
- **Security**: Client-initiated actions cannot be trusted — the server must validate every action against current game state
- **Consistency**: All clients receive the same update via broadcast, preventing visual desynchronization

## 3. Execution Types

Actions are classified by their targeting requirements:

- **Direct** — Instant execution for actions with no target or spatial consideration
- **Spatial** — Targeted actions requiring a map click (movement, ranged attacks)
- **Self-Target** — Actions that affect only the executing entity
- **Multi-Component** — Actions requiring multiple selected components with synergy computation
- **Component Attack** — Component-targeted attacks (punch, cut) with unified frontend handler

### Component Attack Execution

The component attack system provides a **generic, data-driven handler** for all component-targeted actions. Previously, each attack type had its own frontend handler, which violated the Single Responsibility Principle by coupling frontend logic to specific action names. Because the unified handler derives its behavior from the action definition rather than the action name, new attacks can be added without frontend code changes.

### Range Resolution

Range values come from the action definition and may be fixed or runtime-resolved expressions. Expression-based ranges enable attacks whose reach scales with the entity's stats (e.g., a stronger character having a longer reach), decoupling range logic from hardcoded values.

### Multi-Attacker Synergy

When multiple attacker components are selected, the handler delegates to a batch execution path on the server. This enables cooperative attacks where multiple components contribute damage independently, with synergy computed server-side.

## 4. Component Selection

A selection controller manages which components are locked to a given action. Components are highlighted in the active action and grayed out in others to prevent reuse. This selection UI exists because players need to see and control which components participate in each action.

## 5. Error Handling

All execution errors are routed through a centralized client error controller. This centralization exists because:

- **Consistent UX**: Players receive errors in a uniform format
- **Error classification**: Different error types (selection, execution, movement, range, socket) can be handled differently by the UI
- **Debugging**: A single error pathway makes it easier to trace failures

## 6. Turn-Mode Action Gating

When the client is in turn mode and the round is still in its planning window, every action execution path — including the drop and multi-component paths that originally bypassed the gate — is routed through the turn queue rather than executed immediately. The fence exists because any single bypassing path would let an action slip past the planning barrier and land before other planners finish, silently undermining the fairness the turn system promises; covering every execution path is what makes "turn mode" mean something. Deliberate exceptions are preserved: immediate-mode actions and out-of-turn utility paths (e.g., immediate pickup) are not gated, by design.