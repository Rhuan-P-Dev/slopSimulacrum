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