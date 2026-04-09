# 🖥️ Client User Interface (UI)

## 1. Overview
The Client UI provides a visual representation of the SlopSimulacrum world state, allowing users to track the droid's position and inspect its internal technical state. It is a single-page application (SPA) built with HTML5, CSS3, and vanilla JavaScript.

## 2. Visual Components

### 2.1. The World Map (SVG)
The map is rendered using a Scalable Vector Graphics (SVG) element to ensure clarity and flexibility.
- **Rooms (Nodes)**: Each room is represented as a circular node. The color changes based on whether the droid is currently present.
- **Connections (Edges)**: Lines connecting room nodes represent doors or paths.
- **Droid Marker**: A distinct, glowing point that moves between room nodes as the droid changes location.

### 2.2. Droid Detail Panel
A toggleable overlay or side panel that appears when the droid marker is clicked. It displays:
- **Basic Info**: Entity ID, Blueprint, and Current Location.
- **Component Tree**: A detailed list of all installed components.
- **Stat Breakdown**: Real-time values for traits and properties associated with each component.

### 2.3. Navigation Console
A dedicated area for room navigation buttons. These buttons are dynamically generated based on the `connections` object of the current room in the world state.

## 3. Technical Logic

### 3.1. State Synchronization
The client implements a polling mechanism to stay synchronized with the server:
1. **Fetch**: Calls `GET /world-state`.
2. **Parse**: Extracts `rooms` and `entities` from the response.
3. **Update**: 
    - Dynamically renders markers for all entities present in the world on the SVG map.
    - Updates the active room description based on the primary navigation unit.
    - Refreshes the available navigation buttons.

### 3.2. Map Layout Engine
Since the server does not provide coordinates, the client uses a predefined coordinate map for known logical rooms. If a room is not in the coordinate map, a basic auto-layout (randomized or grid-based) is used to ensure visibility.

### 3.3. Interaction Flow
- **Movement**: Clicking a navigation button sends a `POST /move-entity` request $\rightarrow$ Server updates `stateEntityController` $\rightarrow$ Client polls new state $\rightarrow$ Map updates.
- **Inspection**: Clicking any Entity Marker $\rightarrow$ Client retrieves the specific entity data from `state.entities` $\rightarrow$ Renders detailed component and stat data in the Detail Panel.

## 4. Styling Guide (Cyber-Terminal Aesthetic)
- **Color Palette**:
    - Background: `#0a0a0a` (Deep Black)
    - Primary Accent: `#00ff00` (Matrix Green)
    - Text: `#fff` (White) and `#aaa` (Grey)
    - Highlights: Glowing neon effects using `box-shadow` and `filter: drop-shadow`.
- **Typography**: Monospaced fonts (e.g., 'Courier New') to simulate a retro-futuristic terminal.

---

### 📢 Notice for Future Agents
**Language Requirement:** All source code in this project must be written in **JavaScript**.
**Single Source of Truth:** Always refer to the wiki and its `subMDs` before implementing or modifying code.
