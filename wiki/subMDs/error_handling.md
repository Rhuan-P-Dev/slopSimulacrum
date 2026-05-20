# ⚠️ Error Handling Standard

## 1. Overview

All errors are structured objects with `code`, `message`, `details`, and `level` fields. The `level` enum is `INFO`, `WARN`, `ERROR`, or `CRITICAL`.

## 2. Server Error Codes

| Code | Description |
|------|-------------|
| `ENTITY_NOT_FOUND` | Entity ID not in world state |
| `ACTION_NOT_FOUND` | Action name not registered |
| `MISSING_TRAIT_STAT` | Entity lacks required trait/stat |
| `INSUFFICIENT_DURABILITY` | Component below durability threshold |
| `UNKNOWN_REQUIREMENT_FAILURE` | Requirement check failed |
| `CONSEQUENCE_EXECUTION_FAILED` | Consequence handler error |
| `COMPONENT_BINDING_MISMATCH` | Selected component doesn't match binding roles |
| `SYSTEM_RUNTIME_ERROR` | Unexpected exception |

### Internal Component Error Codes

| Code | Description |
|------|-------------|
| `INTERNAL_COMPONENT_NOT_FOUND` | Type not in registry |
| `INTERNAL_COMPONENT_VOLUME_EXCEEDED` | Host volume insufficient |
| `INTERNAL_COMPONENT_TYPE_EXCLUDED` | Host type in excluded list |

## 3. Client-Side Error Handling

A client error controller maps error codes to human-readable templates. Errors are displayed as notification pop-ups on the screen.

**Client error codes**: `SELECTION_FAILED`, `ACTION_FAILED`, `MOVEMENT_FAILED`, `PUNCH_FAILED`, `TARGET_OUT_OF_RANGE`, `NO_TARGET_FOUND`, `SOCKET_ERROR`, `CONNECTION_ERROR`, `INITIALIZATION_ERROR`, `ACTION_LIST_UPDATE_FAILED`