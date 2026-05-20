# 📡 World State Manager

## 1. Overview

Client-side module for state synchronization. Single source of truth for the current simulation state on the client.

## 2. Public API

| Method | Returns | Description |
|--------|---------|-------------|
| `fetchState()` | Promise with state object | Fetches world state from server |
| `setMyEntityId(entityId)` | void | Sets incarnated entity ID |
| `getMyEntityId()` | entity ID or null | Gets incarnated entity ID |
| `getActiveDroid()` | Droid object or null | Returns active droid for navigation |
| `getState()` | State object or null | Returns full world state |

## 3. Active Droid Resolution

1. **Priority 1**: Use the player's incarnated entity ID if it exists in state
2. **Priority 2**: Fallback to any entity with the default droid blueprint

## 4. Integration

- The app orchestrator calls fetchState during world refresh cycles
- getActiveDroid() provides droid for rendering
- State includes internal components for ComponentViewer
- ComponentViewer accesses internal components on individual entity objects within the state entities array, NOT directly from the top-level internal components field