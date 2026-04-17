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
- Check the `subMDs` folder for more detailed guides.

### 📢 Note for Future Agents
**Language Requirement:** All source code in this project must be written in **JavaScript**.

**Logging Standard:** All controllers must use the centralized `Logger` utility (`src/utils/Logger.js`) for structured logging with severity levels (`INFO`, `WARN`, `ERROR`, `CRITICAL`). The `LLMController` now uses `Logger` instead of `console.*` calls.

**Map Maintenance:** The architecture maps (`map.md` and `subMDs/system_map.md`) must be kept up-to-date. If you modify the controller hierarchy, add new controllers, or change the data flow, you are **required** to update the corresponding maps to maintain the "Single Source of Truth".

**Server API Access:** The server (`src/server.js`) must use `WorldStateController` public API methods (`spawnEntity`, `despawnEntity`, `moveEntity`, `getRoomUidByLogicalId`) instead of directly accessing sub-controllers. See `subMDs/controller_patterns.md` Section 5.1.

The project employs a middleware architecture with two primary flows:
- **LLM Interaction:** `Client` $\rightarrow$ `Server` $\rightarrow$ `LLMController` $\rightarrow$ `LLM Backend`.
- **World State Management:** `Client` $\rightarrow$ `Server` $\rightarrow$ `WorldStateController` $\rightarrow$ `SubControllers`.

**Entity Management Hierarchy:**
For entities and their components, follow this chain of command:
`WorldStateController` $\rightarrow$ `stateEntityController` $\rightarrow$ `entityController` $\rightarrow$ `componentController` $\rightarrow$ `componentStatsController`.

When implementing or modifying any feature that requires the use of a Large Language Model, you **must** use the `LLMController` located in `src/controllers/LLMController.js`. 

When implementing or modifying the game world, environment, or spatial state, you **must** use the `WorldStateController` located in `src/controllers/WorldStateController.js` and its associated sub-controllers.

The server in `src/server.js` acts as the gateway for clients to access these controllers. Do not implement new HTTP calls to the LLM or direct state modifications in the client; instead, extend or utilize the respective controllers to maintain a single source of truth.

## 🎮 Action System Architecture

### ActionController

The `ActionController` handles game actions on entities, providing a centralized registry for action definitions and execution:

**updateComponentStatDelta Handler**: Component resolution priority:
1. **Explicit `targetComponentId`** from `actionParams` (targeted actions)
2. **Fulfilling component** from `context.fulfillingComponents` (self-targeting)
3. **Fallback to entity-wide update** via `_handleUpdateStat`

**Note on Stat Persistence**: When actions modify component stats (e.g., `updateComponentStatDelta` for durability loss during dash), the `ComponentStatsController.setStats()` method performs a **deep trait-level merge**. This ensures that updating one stat does not erase other stats in the same trait category. See `wiki/subMDs/traits.md` Section 5 for details.

**Architecture Flow:**
`Server` $\rightarrow$ `WorldStateController` $\rightarrow$ `ActionController` (Injected with `ConsequenceHandlers` and `actionRegistry`)

**Key Responsibilities:**
- Requirement validation for actions (e.g., Movement.move > 5)
- Consequence execution through appropriate sub-controllers
- HTTP API endpoint for action execution (`POST /execute-action`)

**Dependency Chain:**
`WorldStateController` $\rightarrow$ `ActionController`
- `ActionController` receives `WorldStateController` via constructor injection
- Never creates its own controller instances

**Attacker vs. Target Component Resolution (for attack actions):**
For actions that involve both an attacker and a target (e.g., `droid punch`), the `executeAction` method uses two distinct component IDs:
- `attackerComponentId`: The component performing the action. Its stats are used for **requirement value resolution** (e.g., `Physical.strength` determines damage).
- `targetComponentId`: The component being affected. Its stats are used for **consequence application** (e.g., reducing durability).

**Priority order in `executeAction()`:**
1. `attackerComponentId` (highest priority) - Used for actions like punch
2. `targetComponentId` (legacy) - Used for single-component actions
3. Entity-wide check (fallback)

**Sub-Controllers Accessed:**
- `stateEntityController`: Spatial updates via `updateEntitySpatial()`
- `componentController`: Component stats retrieval via `getComponentStats()`
- `RoomsController`: Room data and connections

**Documentation:** See `wiki/subMDs/action_system.md` for complete guide.

### ActionController: Action Capability Cache

The `ActionController` maintains a **capability cache** that maps each action to an **array of all qualifying component entries** across all entities. Every component that meets an action's requirements gets its own entry, sorted by score (best first).

**Removal Markers**: When capability entries are removed, subscribers receive a `RemovalMarker` object (`{ _type: 'REMOVAL', componentId, entityId }`) instead of `null`. This provides structured information about what was removed.

**Cache Structure:**
```
_capabilityCache: { [actionName]: [ComponentCapabilityEntry, ...] }
```

**Key Methods:**
- `scanAllCapabilities(state)` — Full bottom-up scan of all entities/components (stores ALL qualifying entries)
- `reEvaluateActionForComponent(state, actionName, componentId)` — Update/remove single entry in array
- `reEvaluateEntityCapabilities(state, entityId)` — Re-scan all components for an entity
- `removeEntityFromCache(entityId)` — Remove all entries for an entity
- `getActionsForEntity(state, entityId)` — Get actions for a specific entity (auto-scans if entity not in cache)
- `getActionCapabilities(state)` — Get all capabilities (auto-scans if cache empty)
- `getCachedCapabilities()` — Return cached data
- `getBestComponentForAction(actionName)` — Get best entry (highest score) for an action
- `getAllCapabilitiesForAction(actionName)` — Get all entries for an action
- `getCapabilitiesForEntity(entityId)` — Get all entries for an entity
- `on(actionName, callback)` / `off(actionName, callback)` — Event subscription

**Auto-Scan Behavior:**
- `getActionsForEntity()` triggers a scan if cache is empty OR entity not in cache
- `getActionCapabilities()` triggers a scan if cache is empty

**Entity Lifecycle Hooks:**
- Entity spawn → `reEvaluateEntityCapabilities(state, entityId)` called automatically
- Entity despawn → `removeEntityFromCache(entityId)` called automatically
- Component add/remove → `POST /refresh-entity-capabilities` API endpoint

### ActionController: Stat Change Notification

The `ActionController` subscribes to stat changes from `ComponentController`:

```
ComponentController.updateComponentStatDelta()
    → _notifyStatChangeListeners()
        → ActionController.onStatChange()
            → _getActionsForTraitStat()
                → reEvaluateActionForComponent()
                    → find entry in array → update/remove → re-sort
                    → _notifySubscribers(actionName, entryOrRemovalMarker)
```

**Event Subscription Callback Signature**:
```javascript
actionController.on(actionName, (actionName, capability) => {
    // capability can be: ComponentCapabilityEntry | RemovalMarker | null
    if (capability && capability._type === 'REMOVAL') {
        // Handle removal
    }
});
```

**Server Endpoints:**
- `GET /action-capabilities` — Returns full cached capabilities (action → array of entries)
- `GET /action-capabilities/:actionName` — Returns all entries for an action (sorted by score)
- `GET /action-capabilities/entity/:entityId` — Returns all entries for an entity
- `POST /refresh-entity-capabilities` — Re-evaluates all capabilities for an entity

### ComponentController: Stat Change Notification

The `ComponentController` provides a listener system for stat changes:

**API:**
- `registerStatChangeListener(listener)` — Register a listener function
- `unregisterStatChangeListener(listener)` — Remove a listener
- Listener signature: `(componentId, traitId, statName, newValue, oldValue)`

**Documentation:** See `wiki/subMDs/action_capability_cache.md` for complete guide.
