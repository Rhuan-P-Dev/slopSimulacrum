# 🖥️ Client User Interface (UI)

## 1. Overview
The Client UI provides a visual representation of the SlopSimulacrum world state, allowing users to track the droid's position and inspect its internal technical state. It is a single-page application (SPA) built with HTML5, CSS3, and vanilla JavaScript.

### 1.1. File Structure
To ensure maintainability and separation of concerns, the frontend is split into three dedicated files:
- `public/index.html`: Defines the structural layout and DOM elements.
- `public/styles.css`: Contains all visual styling and the "Cyber-Terminal" aesthetic.
- `public/app.js`: Contains the client-side logic, API communication, and UI rendering engine.

## 2. Visual Components

### 2.1. The World Map (SVG)
The map is rendered using a Scalable Vector Graphics (SVG) element to ensure clarity and flexibility.
- **Rooms (Nodes)**: Each room is represented as a circular node. The color changes based on whether the droid is currently present.
- **Connections (Edges)**: Lines connecting room nodes represent doors or paths.
- **Droid Marker**: A distinct, glowing point that moves between room nodes as the droid changes location. The marker for the player's own incarnated entity is highlighted to distinguish it from other entities.

### 2.2. Droid Detail Panel
A toggleable overlay or side panel that appears when the droid marker is clicked. It displays:
- **Basic Info**: Entity ID, Blueprint, and Current Location.
- **Component Tree**: A detailed list of all installed components.
- **Stat Breakdown**: Real-time values for traits and properties associated with each component.

### 2.3. Navigation Console
A dedicated area for room navigation buttons. These buttons are dynamically generated based on the `connections` object of the current room in the world state.

## 3. Technical Logic

### 3.1. State Synchronization
The client implements a hybrid synchronization model:

1. **Identity Establishment (Event-Driven)**: Upon connection, the client establishes a WebSocket connection. The server sends an `incarnate` event containing a unique `entityId`. This ID becomes the client's identity for the session.
2. **State Polling**: The client continuously polls `GET /world-state` to synchronize the visual world state.
3. **Update**: 
    - Dynamically renders markers for all entities present in the world on the SVG map.
    - Updates the active room description and navigation buttons based on the `entityId` assigned during incarnation.

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
    1. User selects a movement action (e.g., `move` or `dash`) from the Action Registry $\rightarrow$ Action is highlighted using the `.action-selected` class.
    2. User clicks a location on the World Map $\rightarrow$ Client sends `POST /execute-action` with relative target coordinates $\rightarrow$ Server updates `stateEntityController` $\rightarrow$ Client polls new state $\rightarrow$ Map updates.
- **Inspection**: Clicking any Entity Marker $\rightarrow$ Client retrieves the specific entity data from `state.entities` $\rightarrow$ Renders detailed component and stat data in the Detail Panel.

### 3.5. Room Coordinates Display
The UI shows current room coordinates in the format: `(x, y)` on the map header.

### 3.6. Action Execution
For detailed information on how the client handles action requests and requirement visualization, see the [Client-Side Action Execution](./client_action_execution.md) documentation.

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
