# 🖥️ Client User Interface (UI)

## 1. Overview
The Client UI provides a visual representation of the SlopSimulacrum world state, allowing users to track the droid's position and inspect its internal technical state. It is a single-page application (SPA) built with HTML5, CSS3, and vanilla JavaScript.

### 1.1. File Structure
To ensure maintainability and separation of concerns, the frontend utilizes a modular architecture:
- `public/index.html`: Defines the structural layout and DOM elements.
- `public/styles.css`: Contains all visual styling and the "Cyber-Terminal" aesthetic.
- `public/js/`: Contains the modular logic split into specialized managers:
    - `App.js`: The main orchestrator (ClientApp) that coordinates all managers.
    - `Config.js`: Centralized configuration and constants.
    - `WorldStateManager.js`: Manages state synchronization and the "Single Source of Truth".
    - `UIManager.js`: Handles all DOM/SVG rendering and user interface interactions.
    - `ActionManager.js`: Manages action execution and the movement target-selection flow.
    - `ClientErrorController.js`: Handles the resolution and formatting of system errors into human-readable messages.

## 2. Visual Components

### 2.1. The World Map (SVG)
The map is rendered using a Scalable Vector Graphics (SVG) element to ensure clarity and flexibility.
- **Rooms (Nodes)**: Each room is represented as a circular node. The color changes based on whether the droid is currently present.
- **Connections (Edges)**: Lines connecting room nodes represent doors or paths.
- **Droid Marker**: A distinct, glowing point that moves between room nodes as the droid changes location. The marker for the player's own incarnated entity is highlighted to distinguish it from other entities.
- **Range Indicators**: When a targeted action is selected, a dashed circle is rendered around the active droid, indicating the maximum effective range. 
    - **Red**: Used for attack actions.
    - **White**: Used for movement actions (`move`, `dash`).

### 2.2. Droid Detail Panel
A toggleable overlay or side panel that appears when the droid marker is clicked. It displays:
- **Basic Info**: Entity ID, Blueprint, and Current Location.
- **Component Tree**: A detailed list of all installed components.
- **Stat Breakdown**: Real-time values for traits and properties associated with each component.
- **Tactical Targeting HUD**: A specialized overlay for target acquisition. It displays a list of the target entity's components as "Target Cards," including visual health bars (durability) and a lock-on aesthetic.

### 2.3. Navigation Console
A dedicated area for room navigation buttons. These buttons are dynamically generated based on the `connections` object of the current room in the world state. The action list in this console now dynamically displays the component responsible for each available action (e.g., "Legs (leg_01)"), providing better technical clarity on which part of the droid is performing the action.

## 3. Technical Logic

### 3.1. State Synchronization
The client implements a hybrid synchronization model coordinated by the `ClientApp` orchestrator:

1. **Identity Establishment (Event-Driven)**: Upon connection, the client establishes a WebSocket connection. The server sends an `incarnate` event; `ClientApp` updates the `WorldStateManager` with the assigned `entityId`.
2. **Real-Time Trigger (WebSocket)**: The client listens for a `world-state-update` event. When received, `ClientApp` triggers a full refresh of both world state and actions.
3. **State Retrieval (REST)**:
    - `WorldStateManager.fetchState()` retrieves the latest world state via `GET /world-state`.
    - `ActionManager.fetchActions()` retrieves the action registry via `GET /actions`.
4. **UI Update**:
    - `UIManager.updateWorldView()` renders the room and active droid.
    - `UIManager.updateEntityAndComponentViews()` is the public interface for updating entity and component layers with custom callbacks.
    - `UIManager.renderActionList()` updates the control panel with available actions.

### 3.2. Map Layout Engine (Spatial Coordinates)
The server now provides room coordinates in the `/world-state` response. Room positions are defined in `RoomsController.js`:
- **Entrance Hall**: x=200, y=250
- **Eastern Corridor**: x=400, y=250
- **Deep Vault**: x=600, y=250

Entity positions are calculated relative to room origins:
- **Entity Position**: `screenX = room.x + entity.spatial.x`
- **Entity Position**: `screenY = room.y + entity.spatial.y`

Component positions are calculated relative to entity positions:
- **Component Position**: `screenX = entity.screenX + component.spatial.x`
- **Component Position**: `screenY = entity.screenY + component.spatial.y`

### 3.3. Entity Rendering
Entities are rendered as circular markers with the following characteristics:
- **Size**: 8px radius (10px on hover)
- **Color**: Neon green (#00ff00)
- **Effect**: Glowing shadow filter
- **Interactivity**: Click to show droid details overlay

### 3.4. Interaction Flow
- **Movement (Target-Based)**: 
    1. User selects a movement action (e.g., `move` or `dash`) $\rightarrow$ `ActionManager` stores the action as a `pendingMovementAction`, `UIManager` highlights it using the `.action-selected` class, and a **white range indicator** is rendered based on the droid's `Movimentation` stats.
    2. User clicks a location on the World Map $\rightarrow$ `ClientApp` calculates relative coordinates and calls `ActionManager.moveToTarget()` $\rightarrow$ Client sends `POST /execute-action` $\rightarrow$ Server updates `stateEntityController` $\rightarrow$ Server broadcasts `world-state-update` $\rightarrow$ Client refreshes state $\rightarrow$ Map updates.
- **Inspection**: Clicking any Entity Marker $\rightarrow$ `UIManager.showEntityDetails()` retrieves the entity data from the `WorldStateManager` $\rightarrow$ Renders detailed component and stat data in the Detail Panel.
- **Attack (Component-Targeted)**: 
    1. User selects an attack action (e.g., `droid punch`) $\rightarrow$ `ActionManager` stores it as a pending action $\rightarrow$ `UIManager` renders a red range indicator.
    2. User clicks an entity within the range $\rightarrow$ `ClientApp` validates distance and identifies the **closest entity** within the `AppConfig.TARGETING.PUNCH_TOLERANCE` to prevent ambiguous target selection when multiple entities are clustered.
    3. `UIManager.showComponentSelection()` displays the Tactical Targeting HUD $\rightarrow$ User selects a specific component to attack.
    4. `ActionManager.executePunch()` sends the `targetComponentId` to the server $\rightarrow$ Server updates the target component's stats $\rightarrow$ Server broadcasts `world-state-update` $\rightarrow$ Client refreshes state.

### 3.5. Room Coordinates Display
The UI shows current room coordinates in the format: `(x, y)` on the map header.

### 3.6. Action Execution
For detailed information on how the client handles action requests and requirement visualization, see the [Client-Side Action Execution](./client_action_execution.md) documentation.

### 3.7. Error Handling
The client utilizes a `ClientErrorController` to decouple error detection from visual presentation. 
- **Logic**: It uses a template-based system to convert error codes (e.g., `TARGET_OUT_OF_RANGE`) and details into human-readable strings.

## 4. Styling Guide (Cyber-Terminal Aesthetic)
- **Color Palette**:
    - Background: `#0a0a0a` (Deep Black)
    - Primary Accent: `#00ff00` (Matrix Green)
    - Text: `#fff` (White) and `#aaa` (Grey)
    - Highlights: Glowing neon effects using `box-shadow` and `filter: drop-shadow`.
    - Error: `#ff4444` (Red, used via `status-fail`)
- **Typography**: Monospaced fonts (e.g., 'Courier New') to simulate a retro-futuristic terminal.

---

### 📢 Notice for Future Agents
**Language Requirement:** All source code in this project must be written in **JavaScript**.
**Single Source of Truth:** Always refer to the wiki and its `subMDs` before implementing or modifying code.
