# Core Wiki

This wiki is specifically designed for AI agents interacting with the `slopSimulacrum` project. It serves as the central knowledge base for understanding the system architecture, conventions, and mandatory standards.

---

## 🗺️ Architectural Maps

This wiki contains **architectural maps** that describe the system structure, controller relationships, and data flow. All agents **must** reference these maps before making any code changes:

- **[Controller Relationship Map](map.md)** — High-level map of the controller ecosystem, dependency graph, and data files. Shows the dependency chain and flow of data/commands across the system.
- **[System Architecture Map](subMDs/architecture/system_map.md)** — Deep-detailed version of the architecture. Includes controller hierarchy, responsibility matrix, key operational flows, and client-side architecture breakdown.

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
  - Special notice: `subMDs/controllers/controller_patterns.md` is **obligatory**

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

Additional reference documentation for specific systems and components, organized by category:

### 🏛️ Architecture & System Design
- [System Architecture Map](subMDs/architecture/system_map.md) — Deep-detailed system architecture
- [Server-Client Architecture](subMDs/architecture/server_client_architecture.md) — Client-server communication
- [Server Splitting Architecture](subMDs/architecture/server_splitting.md) — Multiplayer/server split
- [Action System](subMDs/architecture/action_system.md) — Action pipeline architecture

### 🧩 Controllers
- [Controller Patterns](subMDs/controllers/controller_patterns.md) — **Obligatory** design patterns
- [Capability Controller](subMDs/controllers/capability_controller.md) — Component capability cache + scoring
- [Component Selection](subMDs/controllers/component_selection.md) — Selection & locking
- [Config Bar Manager](subMDs/controllers/config_bar_manager.md) — Config bar logic
- [Rooms Controller](subMDs/controllers/rooms_controller.md) — Room management
- [World State Manager](subMDs/controllers/world_state_manager.md) — Client-side state sync
- [Consequence Handler Architecture](subMDs/controllers/consequence_handler_architecture.md) — Consequence dispatch

### 💾 Data Models
- [Components & Entities](subMDs/data/components_and_entities.md) — Entity system + internal components
- [Traits](subMDs/data/traits.md) — Trait system
- [World State](subMDs/data/world_state.md) — World state data model
- [Inventory System](subMDs/data/inventory_system.md) — Volume-based item storage on components

### 🖥️ Frontend & UI
- [Client Architecture](subMDs/frontend/client_architecture.md) — Client-side architecture + UI overview
- [Client Action Execution](subMDs/frontend/client_action_execution.md) — Client action flow
- [CSS Architecture](subMDs/frontend/css_architecture.md) — CSS module organization

### 🌐 Networking & Communication
- [Communication & Error Handling](subMDs/networking/communication.md) — LLM integration + error codes

### 🎮 Systems & Mechanics
- [Synergy System](subMDs/systems/synergy.md) — Synergy engine + preview UI
- [Movement System](subMDs/systems/movement_system.md) — Movement mechanics
- [World Map](subMDs/systems/world_map.md) — Map visualization

- [Bugfix Wiki](bugfixWiki/README.md)
