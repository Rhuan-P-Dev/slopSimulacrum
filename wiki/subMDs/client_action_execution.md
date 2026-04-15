# ⚡ Client-Side Action Execution

## 1. Overview

This document details the technical implementation and lifecycle of executing actions from the client user interface. It explains how the frontend communicates with the server, manages requirement visualization, and handles the results of action attempts.

---

## 2. Action Execution Lifecycle

The process of performing an action follows a request-response cycle, which varies depending on the action type:

### 2.1. Standard Actions (Direct Execution)
For non-movement actions, the flow is immediate:
1.  **Trigger**: The client maintains a WebSocket connection to the server.
2.  **User Interaction**: The user clicks on a "capable" component within an action item.
3.  **Request Dispatch**: The client sends a `POST /execute-action` request with `actionName`, `entityId`, and `params` (component details).
4.  **Response**: The server executes the action, and the client updates the UI.

### 2.2. Movement Actions (Deferred Execution)
Movement actions (defined in `AppConfig.ACTIONS`, e.g., `MOVE`, `DASH`) use a two-step "Pending" state to allow for target selection on the map:
1.  **Action Selection**: The user clicks a movement action. Instead of calling the server, the client stores the action details in a `pendingMovementAction` state, highlights the action in the UI, and renders a **white range indicator** around the droid to visualize the possible movement distance.
2.  **Target Selection**: The user clicks a location on the spatial map.
3.  **Request Dispatch**: The client sends the `POST /execute-action` request, including:
    *   `actionName`: (e.g., "move" or "dash").
    *   `entityId`: The ID of the entity.
    *   `params`: The `targetX` and `targetY` coordinates relative to the room center.
4.  **Execution**: The server calculates the movement based on the action's speed (e.g., `:traitValue` or `:traitValue*2`) and updates the entity's position.
5.  **Reset**: The `pendingMovementAction` is cleared.
6.  **Server Processing**: The server validates requirements and executes consequences.
7.  **Response & UI Update**: Upon successful execution, the server emits a `world-state-update` event via WebSockets. The client receives this signal and immediately triggers `fetchWorldState()` and `fetchActions()` to refresh the UI.

### 2.3. Component-Targeted Actions (Deferred Execution)
Attack actions (e.g., `droid punch`) use a three-step "Pending" state to allow for precision targeting:
1.  **Action Selection**: The user clicks an attack action. The client stores it as a pending action and `UIManager` renders a red range indicator around the droid.
2.  **Target Entity Selection**: The user clicks an entity on the map. `ClientApp` validates if the entity is within the action's `range` and uses `AppConfig.TARGETING.PUNCH_TOLERANCE` to determine if a click is close enough to an entity to count as a hit.
3.  **Component Selection**: If valid, `UIManager.showComponentSelection()` opens the Tactical Targeting HUD, allowing the user to pick a specific component of the target entity.
4.  **Request Dispatch**: The client sends the `POST /execute-action` request, including:
    *   `actionName`: (e.g., "droid punch").
    *   `entityId`: The ID of the attacker.
    *   `params`: The `targetComponentId` of the selected component.
5.  **Execution**: The server applies damage to the specific component's durability.
6.  **Reset**: The pending action is cleared and the UI is refreshed via the standard `world-state-update` flow.

---

## 3. Data Structures & Requirements

### 3.1. The `/actions` Response

The client relies on the following data structure returned by the server to populate the UI. When requested with an `entityId`, the server returns only the actions relevant to that specific entity.


```json
{
  "actions": {
    "droid dash - up": {
      "requirements": [
        { "trait": "Movimentation", "stat": "move", "minValue": 5 },
        { "trait": "Physical", "stat": "durability", "minValue": 30 }
      ],
      "canExecute": [
        {
          "entityId": "uuid-droid-123",
          "componentName": "Legs",
          "componentIdentifier": "comp-leg-001",
          "currentValue": 15,
          "requiredValue": 30
        }
      ],
      "cannotExecute": [
        { "entityId": "uuid-droid-123", "componentName": "Arm", "componentIdentifier": "comp-arm-001" }
      ]
    }
  }
}
```

### 3.2. Requirement Visualization

To provide clear feedback, the client renders requirements in the following way:

*   **Requirement List**: Every action displays its full list of requirements as a bulleted list under the action name.
*   **Capability Status**:
    *   **Capable Components**: Displayed with a `status-ok` (green) color for the current value and `status-req` (orange) for the required value.
    *   **Incapable Entities**: Listed in red, showing only the specific stats that are required by the action.

---

## 4. Implementation Details (Frontend)

### 4.1. Rendering Logic (`UIManager.renderActionList`)

The `renderActionList` method in the `UIManager` class is responsible for:
1.  Iterating through the `actions` object.
2.  Mapping the `canExecute` array to clickable HTML elements, utilizing data attributes to store action and component identifiers.
3.  Filtering and listing incapable components' required stats in red.
4.  Attaching click listeners that trigger the `onActionClick` callback provided by the orchestrator.

### 4.2. Execution Logic (`ActionManager.executeAction`)

**Registry Pattern**: To avoid "magic strings" and ensure consistency, all action type checks (e.g., identifying movement actions) must use constants defined in `AppConfig.ACTIONS`.

When a user clicks a capable component, the `ActionManager.executeAction` method is called via the `ClientApp` orchestrator. It receives:
*   `actionName`
*   `entityId`
*   `componentName`
*   `componentIdentifier`

The manager then determines if the action is a deferred type (movement or targeted attack, which trigger a "Pending" state for target selection) or a standard action (which is dispatched immediately via a `POST` request to `/execute-action`).

---

## 5. Error Handling

The client handles errors through a structured pipeline that decouples detection from visual presentation, utilizing the `ClientErrorController`.

### 5.1. Error Reporting Flow
When an error occurs (e.g., a failed HTTP request or a targeting validation failure), the following flow is triggered:
`ActionManager` / `ClientApp` $\rightarrow$ `ClientErrorController` $\rightarrow$ `UIManager.showErrorPopup()`

### 5.2. Error Types and Behavior

| Error Type | Source | Client Behavior |
|------------|--------|-----------------|
| **Network/HTTP Error** | Connectivity or Server Down | Structured error passed to `ClientErrorController` $\rightarrow$ Red Pop-up. |
| **Action Failure** | Requirements not met or System Error | Structured error (with `code` and `details`) passed to `ClientErrorController` $\rightarrow$ Template resolution $\rightarrow$ Red Pop-up. |
| **Validation Error** | Client-side check (e.g., Range) | Immediate structured error dispatch to `ClientErrorController` $\rightarrow$ Red Pop-up (e.g., *"Target out of range (219px > 100px)"*). |

---

### 📢 Notice for Future Agents
**Language Requirement:** All frontend logic is written in **Vanilla JavaScript**.
**Single Source of Truth:** The client synchronizes its view with the server using a hybrid model (WebSocket triggers $\rightarrow$ REST fetch) to ensure the UI reflects the simulation state in real-time.
