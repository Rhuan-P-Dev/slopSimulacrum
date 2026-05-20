# Client-Side Action Execution

## 1. Overview

Action execution flows from user input through the server to a broadcast refresh. The server is the authority — the client never mutates game state directly.

## 2. Why Action Execution Is Asynchronous

Actions are sent to the server for validation because:

- **Server authority**: The server holds the single source of truth for entity state, room connectivity, and action requirements
- **Security**: Client-initiated actions cannot be trusted — the server must validate every action against current game state
- **Consistency**: All clients receive the same update via broadcast, preventing visual desynchronization

## 3. Execution Types

| Type | Purpose |
|------|---------|
| **Direct** | Instant execution for actions with no target or spatial consideration |
| **Spatial** | Targeted actions requiring a map click (movement, ranged attacks) |
| **Self-Target** | Actions that affect only the executing entity |
| **Multi-Component** | Actions requiring multiple selected components with synergy computation |

## 4. Component Selection

A selection controller manages which components are locked to a given action. Components are highlighted in the active action and grayed out in others to prevent reuse. This selection UI exists because players need to see and control which components participate in each action.

## 5. Error Handling

All execution errors are routed through a centralized client error controller. This centralization exists because:

- **Consistent UX**: Players receive errors in a uniform format
- **Error classification**: Different error types (selection, execution, movement, range, socket) can be handled differently by the UI
- **Debugging**: A single error pathway makes it easier to trace failures