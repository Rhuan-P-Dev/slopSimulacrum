# 🗺️ Movement System

## 1. Overview
The movement system allows entities to navigate the spatial map of a room. It uses a target-based approach where the destination is selected via a user interface (map click), and the backend calculates the incremental movement based on the entity's traits.

## 2. Interaction Flow (Client-Side)
To prevent accidental movement and allow for different movement types (e.g., normal move vs. dash), the system employs a two-step interaction process:

1.  **Action Selection:** The user selects a movement action (`move` or `dash`) from the Action Registry.
    - **Visual Feedback:** The selected action is highlighted in the UI using the `.action-selected` class.
    - **Toggling:** Clicking the same movement action again will deselect it, clearing the pending state.
2.  **Target Selection:** The user clicks a location on the spatial map. The movement only executes if an action was previously selected.

### 2.1. Client State Management
The `public/app.js` maintains a `pendingMovementAction` state:
- When a movement action is clicked, the action details are stored in `pendingMovementAction` (or cleared if already selected).
- The map click listener only executes if `pendingMovementAction` is not null.
- After the movement is triggered, `pendingMovementAction` is reset to `null`.

## 3. Technical Implementation (Backend)

### 3.1. Target-Based Calculation
Movement is handled by the `ActionController._handleDeltaSpatial` method. Instead of fixed directions, it calculates a normalized direction vector towards the target.

**Mathematical Logic:**
1.  **Direction Vector:** $\vec{d} = (targetX - currentX, targetY - currentY)$
2.  **Distance:** $dist = \sqrt{dx^2 + dy^2}$
3.  **Normalization & Scaling:** 
    - If $dist > 0$: $\text{move} = (\frac{dx}{dist}, \frac{dy}{dist}) \times \text{speed}$
    - Else: $\text{move} = (0, 0)$

### 3.2. Speed and Multipliers
The movement speed is determined by the action definition in the registry:
- **Move:** Uses `:traitValue` (the base `Movimentation.move` stat).
- **Dash:** Uses `:traitValue*2` (double the base move stat), but consumes 5 durability.

## 4. Coordinate Translation
The system translates screen coordinates to room-relative coordinates:
1.  **Screen to SVG:** The click event coordinates are transformed using the SVG's coordinate system (`getScreenCTM().inverse()`).
2.  **SVG to Relative:** The resulting coordinates are offset by the center of the view (`CENTER_X`, `CENTER_Y`) to align with the entity's spatial data (where $0,0$ is the center of the room).
