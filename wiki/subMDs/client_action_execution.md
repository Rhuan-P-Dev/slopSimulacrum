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
Movement actions (`move`, `dash`) use a two-step "Pending" state to allow for target selection on the map:
1.  **Action Selection**: The user clicks a movement action. Instead of calling the server, the client stores the action details in a `pendingMovementAction` state and highlights the action in the UI.
2.  **Target Selection**: The user clicks a location on the spatial map.
3.  **Request Dispatch**: The client sends the `POST /execute-action` request, including:
    *   `actionName`: (e.g., "move" or "dash").
    *   `entityId`: The ID of the entity.
    *   `params`: The `targetX` and `targetY` coordinates relative to the room center.
4.  **Execution**: The server calculates the movement based on the action's speed (e.g., `:traitValue` or `:traitValue*2`) and updates the entity's position.
5.  **Reset**: The `pendingMovementAction` is cleared.
6.  **Server Processing**: The server validates requirements and executes consequences.
7.  **Response & UI Update**: Upon successful execution, the server emits a `world-state-update` event via WebSockets. The client receives this signal and immediately triggers `fetchWorldState()` and `fetchActions()` to refresh the UI.

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

### 4.1. Rendering Logic (`renderActionList`)

The `renderActionList` function in `public/app.js` is responsible for:
1.  Iterating through the `actions` object.
2.  Looping through the `requirements` array for **each** action to build a complete requirement list.
3.  Mapping the `canExecute` array to clickable HTML elements.
4.  Filtering and listing incapable components' required stats in red.

### 4.2. Execution Logic (`executeAction`)

When a user clicks a capable component, the `executeAction` function in `public/app.js` is called with:
*   `actionName`
*   `entityId`
*   `componentName` (extracted from the clicked element)
*   `componentIdentifier` (extracted from the clicked element)

The function sends these via `fetch` and handles both successful executions and error responses (using `alert` for user feedback).

---

## 5. Error Handling

The client handles two main types of errors:

| Error Type | Source | Client Behavior |
|------------|--------|-----------------|
| **Network/HTTP Error** | Connectivity or Server Down | Displays a red error message in the "Status" bar. |
| **Action Failure** | Requirements not met or System Error | Displays an alert box with the descriptive error message provided by the server (e.g., *"Requirement failed: No component possesses the required Physical.durability (>= 30)"*). |

---

### 📢 Notice for Future Agents
**Language Requirement:** All frontend logic is written in **Vanilla JavaScript**.
**Single Source of Truth:** The client synchronizes its view with the server using a hybrid model (WebSocket triggers $\rightarrow$ REST fetch) to ensure the UI reflects the simulation state in real-time.
