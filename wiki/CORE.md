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
- Check the `subMDs` folder for more detailed guides.

### 📢 Note for Future Agents
**Language Requirement:** All source code in this project must be written in **JavaScript**.

**Map Maintenance:** The architecture maps (`map.md` and `subMDs/system_map.md`) must be kept up-to-date. If you modify the controller hierarchy, add new controllers, or change the data flow, you are **required** to update the corresponding maps to maintain the "Single Source of Truth".

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

**Architecture Flow:**
`Server` $\rightarrow$ `WorldStateController` $\rightarrow$ `ActionController` (Injected with `ConsequenceHandlers` and `actionRegistry`)

**Key Responsibilities:**
- Requirement validation for actions (e.g., Movimentation.move > 5)
- Consequence execution through appropriate sub-controllers
- HTTP API endpoint for action execution (`POST /execute-action`)

**Dependency Chain:**
`WorldStateController` $\rightarrow$ `ActionController`
- `ActionController` receives `WorldStateController` via constructor injection
- Never creates its own controller instances

**Sub-Controllers Accessed:**
- `stateEntityController`: Spatial updates via `updateEntitySpatial()`
- `componentController`: Component stats retrieval via `getComponentStats()`
- `RoomsController`: Room data and connections

**Documentation:** See `wiki/subMDs/action_system.md` for complete guide.
