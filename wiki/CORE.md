# Core Wiki

This wiki is specifically designed for AI agents. 

### ⚠️ Mandatory Requirement for AI Agents
All AI agents working on this project **must** use this wiki and its `subMDs` as the **single source of truth** for all code implementations. 

**It is a strict requirement to read and analyze the relevant sections of the wiki and sub-wikis BEFORE writing or modifying any code.**

**Special Notice on Architecture:** The `subMDs/controller_patterns.md` guide is **obligatory**. All controllers must be implemented using the specified Dependency Injection patterns to prevent critical state desynchronization.

## Table of Contents
- [About the Project](#)
- [LLM Integration](subMDs/llm_integration.md)
- [Server-Client Architecture](subMDs/server_client_architecture.md)
- [Controller Patterns](subMDs/controller_patterns.md)

## Sub-Documentation
- [Code Quality and Best Practices](code_quality_and_best_practices.md)
- [LLM Integration](subMDs/llm_integration.md)
- [Server-Client Architecture](subMDs/server_client_architecture.md)
- [Controller Patterns](subMDs/controller_patterns.md)
- Check the `subMDs` folder for more detailed guides.

### 📢 Note for Future Agents
**Language Requirement:** All source code in this project must be written in **JavaScript**.

The project employs a middleware architecture with two primary flows:
- **LLM Interaction:** `Client` $\rightarrow$ `Server` $\rightarrow$ `LLMController` $\rightarrow$ `LLM Backend`.
- **World State Management:** `Client` $\rightarrow$ `Server` $\rightarrow$ `WorldStateController` $\rightarrow$ `SubControllers`.

**Entity Management Hierarchy:**
For entities and their components, follow this chain of command:
`WorldStateController` $\rightarrow$ `stateEntityController` $\rightarrow$ `entityController` $\rightarrow$ `componentController` $\rightarrow$ `componentStatsController`.

When implementing or modifying any feature that requires the use of a Large Language Model, you **must** use the `LLMController` located in `src/controllers/LLMController.js`. 

When implementing or modifying the game world, environment, or spatial state, you **must** use the `WorldStateController` located in `src/controllers/WorldStateController.js` and its associated sub-controllers.

The server in `src/server.js` acts as the gateway for clients to access these controllers. Do not implement new HTTP calls to the LLM or direct state modifications in the client; instead, extend or utilize the respective controllers to maintain a single source of truth.
