# 📡 World State Manager

## 1. Overview
The `WorldStateManager` is a client-side module that handles synchronization and storage of the world state. It acts as the single source of truth for the current simulation state on the client.

**File:** `public/js/WorldStateManager.js`

## 2. Architecture

### 2.1. Role
- **State Storage**: Holds the full world state object (`this.state`)
- **Entity Tracking**: Stores the ID of the entity controlled by the user (`this.myEntityId`)
- **Droid Resolution**: Determines which entity is the "active droid" for navigation and rendering

### 2.2. Dependency Injection
`WorldStateManager` has no external dependencies — it only imports `AppConfig` for default blueprint constants.

```javascript
import { AppConfig } from './Config.js';

export class WorldStateManager {
    constructor() {
        this.state = null;
        this.myEntityId = null;
    }
}
```

## 3. Public Methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `setMyEntityId(entityId)` | `string` | `void` | Sets the ID of the entity controlled by this client |
| `getMyEntityId()` | — | `string\|null` | Gets the ID of the entity controlled by this client |
| `fetchState()` | — | `Promise<Object|null>` | Fetches the latest world state from `GET /world-state` |
| `getActiveDroid()` | — | `Object|null` | Returns the primary droid for navigation/rendering |
| `getState()` | — | `Object|null` | Returns the current world state |

## 4. Active Droid Resolution

The `getActiveDroid()` method uses a priority-based approach to determine which entity to control:

1. **Priority 1**: The incarnated entity (`this.myEntityId`) — if it exists in the state
2. **Priority 2**: Any droid with the default blueprint (`AppConfig.DEFAULTS.DROID_BLUEPRINT`)

```javascript
getActiveDroid() {
    if (!this.state || !this.state.entities) return null;

    // Priority 1: Incarnated entity
    if (this.myEntityId && this.state.entities[this.myEntityId]) {
        return this.state.entities[this.myEntityId];
    }

    // Priority 2: Default blueprint droid
    return Object.values(this.state.entities)
        .find(e => e.blueprint === AppConfig.DEFAULTS.DROID_BLUEPRINT) || null;
}
```

## 5. State Fetching

The `fetchState()` method retrieves the full world state from the server:

```javascript
async fetchState() {
    const response = await fetch('/world-state');
    if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data = await response.json();
    this.state = data.state;
    return this.state;
}
```

**Response Format:**
```json
{
  "state": {
    "rooms": { "room_id": { ... } },
    "entities": { "entity_id": { ... } },
    "components": { "instances": { ... } },
    "actions": { ... }
  }
}
```

## 6. Integration with Other Modules

### 6.1. ClientApp (`App.js`)
- `WorldStateManager` is instantiated in `App.js` constructor
- `fetchState()` is called during `refreshWorldAndActions()`
- `getActiveDroid()` provides the droid for rendering in `UIManager.updateWorldView()`
- `getMyEntityId()` provides the entity ID for navigation callbacks

### 6.2. UIManager
- Receives state from `WorldStateManager` via `App.js`
- Uses `state.rooms`, `state.entities`, `state.components` for rendering

### 6.3. WorldMapView
- Uses `WorldStateManager` indirectly through `App.js`
- `setCurrentRoomId()` receives the room ID from the active droid's location

## 7. Data Flow Diagram

```mermaid
graph TD
    subgraph "Data Source"
        SERVER[Server GET /world-state]
    end

    subgraph "State Management"
        WSM[WorldStateManager]
        WSM -->|state| STATE[World State Object]
        WSM -->|myEntityId| ENTITY[Controlled Entity ID]
    end

    subgraph "Consumers"
        APP[ClientApp]
        UI[UIManager]
        WMV[WorldMapView]
    end

    SERVER -->|fetchState()| WSM
    WSM -->|getActiveDroid()| APP
    APP -->|state + droid| UI
    APP -->|currentRoomId| WMV
```

## 8. Recent Changes

| Date | Change |
|------|--------|
| 2026-05-13 | **Feature:** Added as part of world map system — provides state synchronization for world map rendering |

## 9. Design Notes

- **Single Source of Truth**: `WorldStateManager` ensures all client modules read from the same state object
- **Null Safety**: All methods handle null state gracefully (returning `null` or empty values)
- **No Mutation**: The state is replaced entirely via `this.state = data.state` rather than merged, preventing stale data issues