# Core Wiki

This wiki is specifically designed for AI agents interacting with the `slopSimulacrum` project. It serves as the central knowledge base for understanding the system architecture, conventions, and mandatory standards.

---

## 🗺️ Architectural Maps

This wiki contains **architectural maps** that describe the system structure, controller relationships, and data flow. All agents **must** reference these maps before making any code changes:

- **[Controller Relationship Map](map.md)** — High-level map of the controller ecosystem, dependency graph, and data files. Shows the dependency chain and flow of data/commands across the system.
- **[System Architecture Map](subMDs/system_map.md)** — Deep-detailed version of the architecture. Includes controller hierarchy, responsibility matrix, key operational flows, and client-side architecture breakdown.

These maps must be kept up-to-date. If you modify the architecture, update both maps accordingly.

---

## ⚖️ Rules & Code Quality

This project has **mandatory rules** and **code quality standards** that **all agents must follow**. These are strict requirements, not suggestions.

- **[Project Rules](project_rules.md)** — Critical constraints and standards including:
  - Single Source of Truth (use injected controllers, never direct internal state access)
  - One-way data flow (top to bottom)
  - Public API only communication between controllers
  - Centralized logging standard
  - Defensive copying requirement for state controllers
  - Data loading standard (use `DataLoader.loadJsonSafe`, never `fs.readFileSync` directly)
  - Validation pattern (all state controllers must implement `_validate*()` methods)
  - Special notice: `subMDs/controller_patterns.md` is **obligatory**

- **[Code Quality and Best Practices](code_quality_and_best_practices.md)** — Engineering standards including:
  - Single Responsibility Principle (SRP)
  - Loose coupling between controllers
  - Data-driven design
  - Semantic naming and strong typing
  - Robust error handling and graceful degradation
  - Schema validation for all LLM communication
  - Document "why", not "how"
  - Unit testing requirements
  - Continuous refactoring mandate
  - Atomic commits and state persistence

**Violating these rules will result in rejected changes.**

---

## 📚 Sub-Documentation

Additional reference documentation for specific systems and components:

- [Bugfix Wiki](bugfixWiki/README.md)
- [Controller Patterns](subMDs/controller_patterns.md)
- [Action System](subMDs/action_system.md)
- [Action Capability Cache](subMDs/action_capability_cache.md)
- [Component Capability Controller](subMDs/component_capability_controller.md)
- [Synergy System](subMDs/synergy_system.md)
- [Synergy Preview System](subMDs/synergy_preview.md)
- [Client Action Execution](subMDs/client_action_execution.md)
- [Server-Client Architecture](subMDs/server_client_architecture.md)
- [Server Splitting Architecture](subMDs/server_splitting.md)
- [LLM Integration](subMDs/llm_integration.md)
- [Movement System](subMDs/movement_system.md)
- [Error Handling](subMDs/error_handling.md)
- [Traits](subMDs/traits.md)
- [World State](subMDs/world_state.md)
- [World Map](subMDs/world_map.md)
- [Config Bar Manager](subMDs/config_bar_manager.md)
- [World State Manager](subMDs/world_state_manager.md)
- [CSS Architecture](subMDs/css_architecture.md)
- [Client-Side Architecture](subMDs/client_side_architecture.md)
