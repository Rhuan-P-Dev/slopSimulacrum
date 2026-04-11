# ⚡ Client-Side Action Execution

## 1. Overview

This document details the technical implementation and lifecycle of executing actions from the client user interface. It explains how the frontend communicates with the server, manages requirement visualization, and handles the results of action attempts.

---

## 2. Action Execution Lifecycle

The process of performing an action follows a strict request-response cycle:

1.  **Polling**: The client continuously polls the `/actions` endpoint (every 3 seconds) to synchronize the "Action Registry" with the current server state.
2.  **Capability Check**: The client receives a list of actions, including which entities/components are currently capable of performing them and which are not.
3.  **User Interaction**: The user clicks on a "capable" component within an action item in the Action Registry.
4.  **Request Dispatch**: The client sends a `POST /execute-action` request containing:
    *   `actionName`: The unique name of the action.
    *   `entityId`: The ID of the entity performing the action.
    *   `params`: Specifically, the `componentName` and `componentIdentifier` of the component that satisfied the requirements.
5.  **Server Processing**: The server validates requirements and executes consequences.
6.  **Response & UI Update**: The client receives the result (Success or Failure) and triggers a world state refresh to reflect any changes (like spatial movement).

---

## 3. Data Structures & Requirements

### 3.1. The `/actions` Response

The client relies on the following data structure returned by the server to populate the UI:

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
**Single Source of Truth:** The client always synchronizes its view with the server via polling to ensure the UI accurately reflects the simulation state.
