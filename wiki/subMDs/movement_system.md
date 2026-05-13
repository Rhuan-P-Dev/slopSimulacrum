# 🗺️ Movement System

## 1. Overview
The movement system allows entities to navigate the spatial map of a room. It uses a target-based approach where the destination is selected via a user interface (map click), and the backend calculates the incremental movement based on the entity's traits.

### 1.1. Room Transitions

Entities can transition between rooms via two methods:

**In-Room Movement:**
- User clicks a location on the spatial map → `ActionExecutor.executeMoveDroid()` → `POST /move-entity`
- Entity moves within its current room using `deltaSpatial` consequences

**Room-to-Room Navigation:**
- User clicks a room node on the 🌐 World Map overlay → `POST /move-entity` with target room ID
- Server resolves target room via `WorldStateController.moveEntity()` → `RoomsController.getUidByLogicalId()` for logical ID resolution
- Entity's `location` property is updated to the target room's UID

**Data Flow for Room Transition:**
```
Client POST /move-entity { entityId, targetRoomId }
    → Server → WorldStateController.moveEntity(entityId, targetRoomId)
    → RoomsController.getUidByLogicalId(targetRoomId) → targetRoomUid
    → stateEntityController.moveEntity(entityId, targetRoomUid)
    → entity.location = targetRoomUid
    → world-state-update broadcast
```

**Logical ID vs UID:** The `targetRoomId` in `data/rooms.json` uses logical IDs (e.g., `'start_room'`). `RoomsController.getUidByLogicalId()` resolves these to UIDs for internal state management. See [world_state.md](world_state.md) Section 2.2.2 for the ID mapping system details.

**Alternative Navigation:** The 🌐 World Map overlay (`WorldMapView.js`) provides an alternative navigation method — clicking a room node on the full world map moves the droid to that room via `POST /move-entity`. See [World Map System](world_map.md) for details.

## 2. Interaction Flow (Client-Side)

### 2.1. World Map Navigation
The world map overlay provides room-to-room navigation:
1. User clicks 🌐 button to open world map overlay
2. User clicks a room node on the map
3. Client sends `POST /move-entity` with the entity ID and target room ID
4. Server updates state → `world-state-update` broadcast

See [World Map System](world_map.md) for full details.

### 2.2. Map Click Flow (After BUG-063 Fix)
To prevent accidental movement and allow for different movement types (e.g., normal move vs. dash), the system employs a two-step interaction process:

1.  **Action Selection:** The user selects a movement action (`move` or `dash`) from the Action Registry.
    - **Visual Feedback:** The selected action is highlighted in the UI using the `.action-selected` class, and a **white range indicator** is rendered around the droid to visualize the effective movement distance.
    - **Toggling:** Clicking the same movement action again will deselect it, clearing the pending state and removing the range indicator.
2.  **Target Selection:** The user clicks a location on the spatial map. The movement only executes if an action was previously selected. Upon successful execution, the server broadcasts a `world-state-update` signal, triggering the client to immediately refresh its state and update the map.

### 2.3. Client State Management
The `public/app.js` maintains a `pendingMovementAction` state:
- When a movement action is clicked, the action details are stored in `pendingMovementAction` (or cleared if already selected).
- The map click listener only executes if `pendingMovementAction` is not null.
- After the movement is triggered, `pendingMovementAction` is reset to `null`.

## 3. Technical Implementation (Backend)

### 3.1. Map Click Implementation
**Note:** `WorldMapView._overlay` must be initialized via `init()` before `show()` can work. See [BUG-063](../bugfixWiki/medium/BUG-063-world-map-view-not-initialized.md).

#### 3.1.1. Coordinate Transformation
The map click listener transforms screen coordinates to SVG coordinates:
```javascript
const point = svg.createSVGPoint();
point.x = event.clientX;
point.y = event.clientY;
const svgP = point.matrixTransform(svg.getScreenCTM().inverse());
```

#### 3.1.2. Movement Execution
After the refactor, movement execution is handled by `ActionExecutor.executeMoveDroid()`:
```javascript
executeMoveDroid(entityId, targetRoomId) {
    fetch(`${config.API_BASE}/move-entity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entityId, targetRoomId })
    });
}
```

### 3.2. Target-Based Calculation
Movement is handled by the `SpatialConsequenceHandler._handleDeltaSpatial` method. The entity moves toward the clicked target position, with behavior that depends on the relationship between the distance to the target and the movement speed.

**Mathematical Logic:**
1.  **Direction Vector:** $\vec{d} = (targetX - currentX, targetY - currentY)$
2.  **Distance:** $dist = \sqrt{dx^2 + dy^2}$
3.  **Conditional Movement:**

| Condition | Movement Result |
|-----------|----------------|
| $dist \leq 0$ | No movement ($\text{move} = (0, 0)$) |
| $dist \leq \text{speed}$ | Entity moves directly to the clicked position ($\text{move} = (dx, dy)$) |
| $dist > \text{speed}$ | Entity moves exactly `speed` units toward the target ($\text{move} = \frac{\vec{d}}{dist} \times \text{speed}$) |

**Behavior:**
- **Click within range:** The entity lands exactly on the clicked position, regardless of whether the distance is less than, equal to, or greater than the speed.
- **Click beyond range:** The entity moves the maximum possible distance (`speed` units) in the direction of the clicked target.
- **Click on the entity:** No movement occurs.

### 3.3. Speed and Multipliers
The movement speed is determined by the action definition in the registry:
- **Move:** Uses `:traitValue` (the base `Movement.move` stat).
- **Dash:** Uses `:traitValue*2` (double the base move stat), but consumes 5 durability.

### 3.4. Component Resolution for Multi-Component Entities

When an entity has multiple components with the same trait (e.g., left and right `droidRollingBall` components with `Movement.move`), the system uses the `targetComponentId` parameter to determine which component's stats should be used for:
- **Requirement value resolution:** The selected component's `Movement.move` value determines movement speed.
- **Consequence application:** For actions like `dash`, durability loss is applied to the selected component (e.g., the right wheel loses durability, not the left).

**Client-Side Flow:**
1. User selects a movement action on a specific component → `componentId` stored in `pendingMovementAction`
2. User clicks map → `ActionManager.moveToTarget()` sends `{ targetX, targetY, targetComponentId, componentIdentifier }`
3. Server resolves requirements and consequences using the correct component

**See also:** [Client-Side Action Execution](client_action_execution.md) Section 2.2

## 4. Coordinate Translation
The system translates screen coordinates to room-relative coordinates:
1.  **Screen to SVG:** The click event coordinates are transformed using the SVG's coordinate system (`getScreenCTM().inverse()`).
2.  **SVG to Relative:** The resulting coordinates are offset by the center of the view (`CENTER_X`, `CENTER_Y`) to align with the entity's spatial data (where $0,0$ is the center of the room).
