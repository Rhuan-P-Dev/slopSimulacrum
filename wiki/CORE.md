# Core Wiki

This wiki is specifically designed for AI agents.

### ⚠️ Mandatory Requirement for AI Agents
All AI agents working on this project **must** use this wiki and its `subMDs` as the **single source of truth** for all code implementations.

**It is a strict requirement to read and analyze the relevant sections of the wiki and sub-wikis BEFORE writing or modifying any code.**

**Special Notice on Architecture:** The `subMDs/controller_patterns.md` guide is **obligatory**. All controllers must be implemented using the specified Dependency Injection patterns to prevent critical state desynchronization.

## Table of Contents
- [About the Project](#)
- [System Architecture Map](subMDs/system_map.md)
- [LLM Integration](subMDs/llm_integration.md)
- [Server-Client Architecture](subMDs/server_client_architecture.md)
- [Controller Patterns](subMDs/controller_patterns.md)
- [Controller Relationship Map](map.md)

## Sub-Documentation
- [Code Quality and Best Practices](code_quality_and_best_practices.md)
- [System Architecture Map](subMDs/system_map.md) (Deep Version)
- [LLM Integration](subMDs/llm_integration.md)
- [Server-Client Architecture](subMDs/server_client_architecture.md)
- [Controller Patterns](subMDs/controller_patterns.md)
- [Controller Relationship Map](map.md)
- [Action System](subMDs/action_system.md)
- [Action Capability Cache](subMDs/action_capability_cache.md)
- [Component Capability Controller](subMDs/component_capability_controller.md)
- [Synergy System](subMDs/synergy_system.md)
- [Component Selection](subMDs/component_selection.md)
- [Client Action Execution](subMDs/client_action_execution.md)
- Check the `subMDs` folder for more detailed guides.

### 📢 Note for Future Agents
**Language Requirement:** All source code in this project must be written in **JavaScript**.

**Logging Standard:** All controllers must use the centralized `Logger` utility (`src/utils/Logger.js`) for structured logging with severity levels (`INFO`, `WARN`, `ERROR`, `CRITICAL`).

**Map Maintenance:** The architecture maps (`map.md` and `subMDs/system_map.md`) must be kept up-to-date.

**Server API Access:** The server (`src/server.js`) must use `WorldStateController` public API methods (`spawnEntity`, `despawnEntity`, `moveEntity`, `getRoomUidByLogicalId`) instead of directly accessing sub-controllers. See `subMDs/controller_patterns.md` Section 5.1.

The project employs a middleware architecture with two primary flows:
- **LLM Interaction:** `Client` → `Server` → `LLMController` → `LLM Backend`.
- **World State Management:** `Client` → `Server` → `WorldStateController` → `SubControllers`.

**Entity Management Hierarchy:**
`WorldStateController` → `stateEntityController` → `entityController` → `componentController` → `componentStatsController`.

## 🎮 Action System Architecture

### ActionController

The `ActionController` handles game action execution, checking requirements and executing consequences through a decoupled handler system.

**Component Binding Resolution Priority:**
1. `attackerComponentId` from params → punch actions
2. `targetComponentId` from params → spatial/self_target actions with explicit selection
3. `targetingType: 'spatial'` → auto-find Movement component
4. `targetingType: 'none'` or `'self_target'` → auto-find Physical self-target component
5. Fallback → entity-wide requirement check

**Self-Targeting Actions (selfHeal):**
Actions with `targetingType: 'self_target'` execute instantly when a component is selected. The client sends `targetComponentId` in params, and the server resolves it via Priority 2 (explicit targetComponentId) before Priority 4 auto-resolution kicks in.

**SRP Note**: Component capability management (scanning, caching, scoring, re-evaluation) has been extracted to `ComponentCapabilityController`. The `ActionController` now delegates all capability cache queries to it.

**Architecture Flow:**
`Server` → `WorldStateController` → `ActionController` (Injected with `ConsequenceHandlers`, `actionRegistry`, and `ComponentCapabilityController`)

**Key Responsibilities:**
- Action execution (`executeAction`)
- Requirement validation
- Consequence execution through `ConsequenceHandlers`
- Placeholder resolution (`_:Trait.stat` patterns)
- Delegates capability cache queries to `ComponentCapabilityController`

**Dependency Chain:**
`WorldStateController` → `ActionController` → `ComponentCapabilityController`

**Documentation:** See `wiki/subMDs/action_system.md` for complete guide.

### ComponentCapabilityController: Action Capability Cache

The `ComponentCapabilityController` (extracted from `ActionController` per SRP) maintains a **capability cache** that maps each action to an **array of all qualifying component entries** across all entities.

**Location**: `src/controllers/componentCapabilityController.js`

### SynergyController: Multi-Entity/Component Synergy

The `SynergyController` computes combined effect multipliers when multiple components or entities collaborate on a single action. Synergy configurations are **decoupled** from action definitions and loaded from `data/synergy.json`.

**Location**: `src/controllers/synergyController.js`

**Constructor:** `constructor(worldStateController, actionRegistry, synergyRegistry)`

**Key Responsibilities:**
- Compute single-entity component group synergy
- Compute multi-entity collaboration synergy
- Compute client-provided multi-component synergy via `_evaluateProvidedComponents()`
- Apply caps to computed multipliers
- Build human-readable summaries

**Integration Flow:**
`ActionController.executeAction()` → `SynergyController.computeSynergy()` → `ConsequenceHandlers` (with synergy-applied values)

**Scaling Utilities**: `src/utils/SynergyScaling.js` (linear, diminishingReturns, increasingReturns)

**Data Source**: Synergy configs are in `data/synergy.json` (standalone), separate from `data/actions.json`.

**Server API:**
- `GET /synergy/actions` — All actions with synergy enabled
- `GET /synergy/config/:actionName` — Synergy config for an action
- `POST /synergy/preview` — Preview synergy without executing (accepts `componentIds` for live client-provided multi-component synergy)

**Documentation**: See `wiki/subMDs/synergy_system.md` for complete guide.

### ActionSelectController: Component Selection/Locking

The `ActionSelectController` enforces the **"one component, one action" rule**: if a component is selected for action A, it cannot be used for action B simultaneously.

**Location**: `src/controllers/actionSelectController.js`

**Key Responsibilities:**
- Lock components to specific actions before execution
- Validate component selection matches the requested action
- Release locks after action completion (success or failure)
- Auto-expire stale selections (30s TTL)
- Provide locked component IDs to SynergyController for exclusion
- Atomic batch locking via `registerSelections()`

**Integration Flow (Single):**
`Client POST /select-component` → `ActionSelectController.registerSelection()` → `ActionController.executeAction()` → `ActionSelectController.validateSelection()` → execute → `ActionSelectController.releaseSelection()` (finally block)

**Integration Flow (Multi-Component Batch):**
`Client POST /select-components` → `ActionSelectController.registerSelections()` → `ActionController.executeAction()` → `ActionSelectController.validateSelections()` → `SynergyController.computeSynergy()` (with `providedComponentIds`) → execute → batch release (finally block)

**Server Endpoints:**
- `POST /select-component` — Lock a component to an action
- `POST /select-components` — Batch lock multiple components to an action
- `POST /release-selection` — Release a component lock
- `GET /selections/:entityId` — Get current selections

**Documentation**: See `wiki/subMDs/component_selection.md` for complete guide.

### Client-Side Multi-Component Selection

The client uses a **click-to-toggle** model for multi-component selection:

- **`activeActionName`** — Currently active action being selected into
- **`selectedComponentIds`** — Set of component IDs selected for active action
- **`crossActionSelections`** — Map of actionName → Set of component IDs (for cross-action graying)

**Flow:**
1. User clicks component row → `_handleComponentToggle()` toggles selection
2. Components selected in active action appear grayed out in other actions
3. For spatial/component actions: pending action is set, enabling map/entity click execution
4. When 2+ components selected: live synergy preview via `POST /synergy/preview`
5. Map click with 2+ components: batch lock → execute with synergy → display result

**UI Elements:**
- `.action-selected` — Green highlight for selected components
- `.component-locked` — Grayed out for cross-action conflict (clickable to clear)
- `.action-active` — Yellow header for active action
- `.synergy-preview-display` — Live synergy preview (yellow, persistent)
- `.synergy-result-display` — Post-execution result (green, auto-hides after 8s)

**Documentation**: See `wiki/subMDs/client_action_execution.md` Section 2.2.5 for complete guide.

**Stat Change Notification Flow:**
```
ComponentController.updateComponentStatDelta()
    → _notifyStatChangeListeners()
        → ComponentCapabilityController.onStatChange()
            → _getActionsForTraitStat()
                → reEvaluateActionForComponent()
                    → find entry → update/remove → re-sort
                    → _notifySubscribers(actionName, entryOrRemovalMarker)
```

**Server Endpoints:**
- `GET /action-capabilities` — `componentCapabilityController.getCachedCapabilities()`
- `GET /action-capabilities/:actionName` — `componentCapabilityController.getBestComponentForAction()`
- `GET /action-capabilities/entity/:entityId` — `componentCapabilityController.getCapabilitiesForEntity()`
- `POST /refresh-entity-capabilities` — `componentCapabilityController.reEvaluateEntityCapabilities()`

**Documentation:** See `wiki/subMDs/component_capability_controller.md` for complete guide.