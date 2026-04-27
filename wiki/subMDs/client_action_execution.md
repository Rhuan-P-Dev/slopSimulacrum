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
1.  **Action Selection**: The user clicks a movement action. `ActionManager.executeAction()` stores the action details in the `_pendingAction` state via `_setPendingAction()`, then invokes the callback (e.g., `() => this.updateActionList()`). The `App.updateActionList()` method detects the pending action, calculates the effective range via `_calculateActionRange()`, and renders a **white range indicator** (SVG dashed circle) around the droid via `UIManager.renderRangeIndicator()`. The selected component's `componentId` and `componentIdentifier` are stored in the pending state.
2.  **Target Selection**: The user clicks a location on the spatial map.
3.  **Request Dispatch**: The client sends the `POST /execute-action` request, including:
    *   `actionName`: (e.g., "move" or "dash").
    *   `entityId`: The ID of the entity.
    *   `params`:
        *   `targetX` and `targetY`: Coordinates relative to the room center.
        *   `targetComponentId`: The component ID of the component selected during action selection. **This is required** to ensure that consequences (e.g., durability loss from `dash`) are applied to the correct component when the entity has multiple components with the same type (e.g., left and right `droidRollingBall` components).
        *   `componentIdentifier`: The identifier of the selected component (e.g., "left", "right").
4.  **Execution**: The server calculates the movement based on the action's speed (e.g., `:traitValue` or `:traitValue*2`) and updates the entity's position.
5.  **Reset**: The `pendingMovementAction` is cleared.
6.  **Server Processing**: The server validates requirements using the `targetComponentId` and executes consequences on the resolved component.
7.  **Response & UI Update**: Upon successful execution, the server emits a `world-state-update` event via WebSockets. The client receives this signal and immediately triggers `fetchWorldState()` and `fetchActions()` to refresh the UI.

### 2.2.5. Multi-Component Actions (Click-to-Toggle Selection + Synergy)

The client uses a **click-to-toggle** model for multi-component selection:

1.  **Component Toggle**: The user clicks component rows in an action list. `_handleComponentToggle()` manages `activeActionName`, `selectedComponentIds` (Set), and `crossActionSelections` (Map). Clicking a component toggles it in/out of the selection. Selected components are highlighted (`action-selected`). Components selected in the active action appear grayed out (`.component-locked`) in all other actions.
2.  **Cross-Action Graying**: Components selected in the active action are added to `crossMap` so they appear grayed out in other actions. Clicking a grayed component clears it from the other action's selection (`_handleGrayedComponentClick()`).
3.  **Action Switching**: Clicking a component in a different action switches the active action, moving old selections to `crossActionSelections`.
4.  **Pending Action Setup**: For spatial/component actions, `_handleComponentToggle()` calls `actions._handleTargetingSelection()` to set the pending action, enabling map/entity click execution.
5.  **Live Synergy Preview**: When 2+ components are selected, `_updateSynergyPreview()` sends `POST /synergy/preview` with `componentIds` and displays the result via `UIManager.renderSynergyPreview()` (yellow border, ⚡ icon).
6.  **Map/Entity Click Execution**: For spatial actions with 2+ selected components, map click triggers `_executeMultiComponentSpatial()`:
    *   `ActionManager.selectComponents()` sends `POST /select-components` for batch lock
    *   `ActionManager.executeWithComponents()` sends `POST /execute-action` with `params.componentIds`
    *   Server computes synergy via `SynergyController.computeSynergy()` with `providedComponentIds`
    *   Client displays final result via `UIManager.renderSynergyResult()` (green border, auto-hides after 8s)
7.  **Cleanup**: All selections cleared via `_clearAllSelections()`, UI refreshes via `world-state-update`.

**Error Recovery**: If `selectComponents()` fails, `_executeMultiComponentSpatial()` clears all client-side selection state (`selectedComponentIds`, `crossActionSelections`, `activeActionName`, synergy preview) to prevent UI/server state mismatch. Additionally, if components are already locked to the **same action** (refresh scenario), `selectComponents()` treats it as success rather than an error, aligning with server-side `ActionSelectController.registerSelections()` behavior.

**Server-Side Lock Release**: The server's `ActionController.executeAction()` explicitly tracks spatial action components in `componentsToRelease` (lines 301-317), ensuring locks are released in the `finally` block via `ActionSelectController.releaseSelections()`. This prevents locks from persisting after spatial actions, which previously broke subsequent actions like `selfHeal`.

**Multi-Select UI Elements:**
*   **Row Click Toggle**: Click component row to toggle selection. No checkboxes.
*   **Selected Highlight** (`.action-selected`): Bright green background for selected components.
*   **Active Action** (`.action-active`): Yellow border/header for the currently active action.
*   **Cross-Action Gray** (`.component-locked`): Reduced opacity for components selected in other actions. Still clickable to clear the conflict. 🔒 icon with tooltip.
*   **Live Synergy Preview** (`.synergy-preview-display`): Yellow-bordered popup at bottom-center, persistent while 2+ components selected.
*   **Final Synergy Result** (`.synergy-result-display`): Green-bordered popup after execution, auto-hides after 8 seconds.

### 2.2.6. Self-Targeting Actions (Instant Execution)

Actions with `targetingType: 'self_target'` (e.g., `selfHeal`) execute **instantly** when a component is selected — no map click or additional confirmation needed.

**Flow:**
1. **Component Selection**: User clicks a component row in the action list
2. **Immediate Execution**: `_handleComponentToggle()` detects `targetingType === 'self_target'` and calls `_executeSelfTargetAction()`
3. **Server Request**: `POST /execute-action` with `targetComponentId` and `componentIdentifier`
4. **Server Resolution**: `ActionController._resolveSourceComponent()` resolves via Priority 2 (explicit targetComponentId)
5. **Consequence Application**: `ConsequenceHandlers.updateComponentStatDelta()` applies the effect to the selected component
6. **UI Refresh**: `world-state-update` event triggers `refreshWorldAndActions()`

**Client Method:** `ClientApp._executeSelfTargetAction(actionName, entityId, componentId, componentIdentifier)`

**Data Flow:**
```
User clicks component → App._handleComponentToggle()
    → targetingType === 'self_target' → _executeSelfTargetAction()
    → POST /execute-action { targetComponentId, componentIdentifier }
    → ActionController.executeAction() → resolve via targetComponentId
    → ConsequenceHandlers.updateComponentStatDelta() → heal component
    → WorldStateController.broadcast() → refresh UI
```

### 2.3. Component-Targeted Actions (Deferred Execution)
Attack actions (e.g., `droid punch`) use a three-step "Pending" state to allow for precision targeting:
1.  **Action Selection**: The user clicks an attack action. `ActionManager.executeAction()` stores it as a pending action via `_setPendingAction()`, then invokes the callback which triggers `App.updateActionList()`. The method calculates the static range from the action data (`actionData.range`) and renders a **red range indicator** (SVG dashed circle) around the droid via `UIManager.renderRangeIndicator()`. The selected attacker component ID (from the action list) is stored in `_pendingAction.componentId`.
2.  **Target Entity Selection**: The user clicks an entity on the map. `ClientApp` validates if the entity is within the action's `range` and uses `AppConfig.TARGETING.PUNCH_TOLERANCE` to determine if a click is close enough to an entity to count as a hit.
3.  **Component Selection**: If valid, `UIManager.showComponentSelection()` opens the Tactical Targeting HUD, allowing the user to pick a specific component of the target entity.
4.  **Request Dispatch**: The client sends the `POST /execute-action` request, including:
    *   `actionName`: (e.g., "droid punch").
    *   `entityId`: The ID of the attacker.
    *   `params`:
        *   `attackerComponentId`: The component performing the attack (e.g., `droidHand`). Its stats are used for **requirement value resolution** (e.g., `Physical.strength` determines damage).
        *   `targetComponentId`: The component being targeted. Its stats are used for **consequence application** (e.g., reducing durability).
5.  **Execution**: The server resolves damage values from the attacker's stats and applies them to the target's durability.
6.  **Reset**: The pending action is cleared and the UI is refreshed via the standard `world-state-update` flow.

**Important**: The `attackerComponentId` must be used for resolving action parameter values (like damage). Using the target's component stats would result in incorrect values (e.g., using global defaults instead of the attacker's actual strength).

---

## 3. Data Structures & Requirements

### 3.1. The `/actions` Response

The client relies on the following data structure returned by the server to populate the UI. When requested with an `entityId`, the server returns only the actions relevant to that specific entity.

```json
{
  "actions": {
    "droid dash - up": {
      "requirements": [
        { "trait": "Movement", "stat": "move", "minValue": 5 },
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
3.  Applying `.action-selected` class for selected components, `.component-locked` for cross-action grayed components, `.action-active` for active action header.
4.  Filtering and listing incapable components' required stats in red.
5.  Attaching click listeners that trigger `onComponentToggle` and `onGrayedComponentClick` callbacks.

### 4.2. Execution Logic (`ActionManager`)

**Registry Pattern**: To avoid "magic strings" and ensure consistency, all action type checks (e.g., identifying movement actions) must use constants defined in `AppConfig.ACTIONS`.

**Methods:**
*   `executeAction()` — Single-component action execution
*   `selectComponents()` — Batch lock via `POST /select-components`
*   `executeWithComponents()` — Multi-component execution via `POST /execute-action` with `componentIds`
*   `previewSynergy()` — Live synergy preview via `POST /synergy/preview`

### 4.3. Multi-Component Execution Logic

**Selection State** (`ClientApp`):
*   `activeActionName` — Currently selected action
*   `selectedComponentIds` — Set of component IDs for active action
*   `crossActionSelections` — Map of actionName → Set of component IDs (for cross-action graying)

**Toggle Flow** (`_handleComponentToggle`):
1.  Switch active action if clicking different action (move old selections to cross map)
2.  Toggle component in/out of `selectedComponentIds`
3.  For spatial/component actions: set pending action via `_handleTargetingSelection()`
4.  Re-render action list
5.  If 2+ selected: fetch live synergy preview

**Cross-Action Clear** (`_handleGrayedComponentClick`):
1.  Remove component from `crossActionSelections` or `selectedComponentIds`
2.  Re-render action list
3.  Update synergy preview

**Synergy Display**:
*   `renderSynergyPreview()` — Live preview (yellow, persistent while selected)
*   `renderSynergyResult()` — Post-execution result (green, auto-hides after 8s)

---

## 5. Error Handling

The client handles errors through a structured pipeline that decouples detection from visual presentation, utilizing the `ClientErrorController`.

### 5.1. Error Reporting Flow
When an error occurs (e.g., a failed HTTP request or a targeting validation failure), the following flow is triggered:
`ActionManager` / `ClientApp` → `ClientErrorController` → `UIManager.showErrorPopup()`

### 5.2. Error Types and Behavior

| Error Type | Source | Client Behavior |
|------------|--------|-----------------|
| **Network/HTTP Error** | Connectivity or Server Down | Structured error passed to `ClientErrorController` → Red Pop-up. |
| **Action Failure** | Requirements not met or System Error | Structured error (with `code` and `details`) passed to `ClientErrorController` → Template resolution → Red Pop-up. |
| **Validation Error** | Client-side check (e.g., Range) | Immediate structured error dispatch to `ClientErrorController` → Red Pop-up (e.g., *"Target out of range (219px > 100px)"*). |

---

### 📢 Notice for Future Agents
**Language Requirement:** All frontend logic is written in **Vanilla JavaScript**.
**Single Source of Truth:** The client synchronizes its view with the server using a hybrid model (WebSocket triggers → REST fetch) to ensure the UI reflects the simulation state in real-time.