# Core Wiki

This wiki is specifically designed for AI agents.

### ⚠️ Mandatory Requirement for AI Agents
All AI agents working on this project **must** use this wiki and its `subMDs` as the **single source of truth** for all code implementations.

**It is a strict requirement to read and analyze the relevant sections of the wiki and sub-wikis BEFORE writing or modifying any code.**

**Special Notice on Architecture:** The `subMDs/controller_patterns.md` guide is **obligatory**. All controllers must be implemented using the specified Dependency Injection patterns to prevent critical state desynchronization.

## Table of Contents
- [About the Project](#)
- [System Architecture Map](subMDs/system_map.md)
- [Controller Relationship Map](map.md)
- [Controller Patterns](subMDs/controller_patterns.md)
- [Action System](subMDs/action_system.md)
- [Action Capability Cache](subMDs/action_capability_cache.md)
- [Component Capability Controller](subMDs/component_capability_controller.md)
- [Synergy System](subMDs/synergy_system.md)
- [Synergy Preview System](subMDs/synergy_preview.md)
- [Component Selection](subMDs/component_selection.md)
- [Client Action Execution](subMDs/client_action_execution.md)
- [Server-Client Architecture](subMDs/server_client_architecture.md)
- [LLM Integration](subMDs/llm_integration.md)
- [Movement System](subMDs/movement_system.md)
- [Client UI](subMDs/client_ui.md)
- [Entities](subMDs/entities.md)
- [Error Handling](subMDs/error_handling.md)
- [Traits](subMDs/traits.md)
- [World State](subMDs/world_state.md)

## Sub-Documentation
- [Code Quality and Best Practices](code_quality_and_best_practices.md)
- [System Architecture Map](subMDs/system_map.md) (Deep Version)
- [Controller Relationship Map](map.md)
- [Controller Patterns](subMDs/controller_patterns.md)
- [Action System](subMDs/action_system.md)
- [Action Capability Cache](subMDs/action_capability_cache.md)
- [Component Capability Controller](subMDs/component_capability_controller.md)
- [Synergy System](subMDs/synergy_system.md)
- [Synergy Preview System](subMDs/synergy_preview.md)
- [Component Selection](subMDs/component_selection.md)
- [Client Action Execution](subMDs/client_action_execution.md)
- [Server-Client Architecture](subMDs/server_client_architecture.md)
- [LLM Integration](subMDs/llm_integration.md)
- [Movement System](subMDs/movement_system.md)
- [Client UI](subMDs/client_ui.md)
- [Entities](subMDs/entities.md)
- [Error Handling](subMDs/error_handling.md)
- [Traits](subMDs/traits.md)
- [World State](subMDs/world_state.md)

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

