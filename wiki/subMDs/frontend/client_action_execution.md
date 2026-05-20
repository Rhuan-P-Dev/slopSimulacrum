# ⚡ Client-Side Action Execution

## 1. Overview

Action execution lifecycle: user selects an action, optionally selects a target, sends a request to the server for validation and execution, receives consequences, and refreshes the display via a broadcast update.

## 2. Execution Types

| Type | Flow | Examples |
|------|------|----------|
| **Direct** | Click component → instant execution → refresh | Melee attacks |
| **Spatial** | Select action → range indicator → click map → execute | Movement, dashes |
| **Self-Target** | Click component → instant self-execution → refresh | Self-healing |
| **Multi-Component** | Toggle multiple components → synergy preview → execute → refresh | Coordinated attacks |

## 3. Component Selection

A selection controller manages the active action, a set of selected component IDs, and cross-action selection state. Selected components are highlighted in the active action's UI and grayed out in others to prevent reuse. Live synergy previews appear when two or more components are selected. Selections are cleaned up on action failure.

## 4. Error Handling

All execution errors are routed through a centralized client error controller that displays notification pop-ups. Error types cover selection failures, action execution failures, movement failures, range violations, and socket connection errors.