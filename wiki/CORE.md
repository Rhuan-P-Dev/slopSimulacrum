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
- [Attack System](subMDs/architecture/attack_system.md) — Generic component-targeted attack handler
- [Killer LLM Drone](subMDs/architecture/killer_llm_drone.md) — Env-gated, goal-bearing LLM-routed NPC: why the drone is pure data on the shared, hardened LLM loop

### 🧩 Controllers
- [Controller Patterns](subMDs/controllers/controller_patterns.md) — **Obligatory** design patterns
- [Capability Controller](subMDs/controllers/capability_controller.md) — Component capability cache + scoring
- [Component Selection](subMDs/controllers/component_selection.md) — Selection & locking
- [EquippedItemStatsController](subMDs/controllers/equipped_item_stats_controller.md) — Per-instance mutable stat tracking for equipped items
- [Requirement Resolver](subMDs/controllers/requirement_resolver.md) — Action requirement validation with equipped item trait resolution
- [Component Resolver](subMDs/controllers/component_resolver.md) — Source/target component resolution with priority chain
- [Config Bar Manager](subMDs/controllers/config_bar_manager.md) — Config bar logic
- [Rooms Controller](subMDs/controllers/rooms_controller.md) — Room management
- [World State Manager](subMDs/controllers/world_state_manager.md) — Client-side state sync
- [Consequence Handler Architecture](subMDs/controllers/consequence_handler_architecture.md) — Consequence dispatch
- [Internal Component Controller](subMDs/controllers/internal_component_controller.md) — State Controller pattern, unified tick system
- [Range Validator](subMDs/controllers/range_validator.md) — Spatial range validation for proximity-based actions

### 💾 Data Models
- [Components & Entities](subMDs/data/components_and_entities.md) — Entity system + internal components
- [Holding Cost](subMDs/data/holding_cost.md) — Equipped item physical burden system
- [Internal Components](subMDs/data/internal_components.md) — Passive data-driven augmentations, tick-based effects
- [Traits](subMDs/data/traits.md) — Trait system
- [World State](subMDs/data/world_state.md) — World state data model
- [Inventory System](subMDs/data/inventory_system.md) — Volume-based item storage on components
- [Material Damage & Chunk Drop](subMDs/data/material_damage_and_drop.md) — Why the attacker's material decides a hit's channel split and why channel-damage hits (punch, cut, shootT1) yield dynamically-generated chunk items with no item-registry entry (safe, data-driven degradation to legacy combat)
- [World Rules](subMDs/data/world_rules.md) — The world-rules layer (data/world_rules.json): stable keys → small config objects governing cross-cutting laws; the shipped torn-material rule is a deterministic complement to the probabilistic chunk stream, and the shipped onDamage event rule adds a probabilistic chunk drop on any damage source (additive to the per-material drops); both degrade gracefully-off, a contract deliberately divergent from the material files' boot-fail rule

### 🖥️ Frontend & UI
- [Client Architecture](subMDs/frontend/client_architecture.md) — Client-side architecture + UI overview
- [Client Action Execution](subMDs/frontend/client_action_execution.md) — Client action flow
- [CSS Architecture](subMDs/frontend/css_architecture.md) — CSS module organization
- [Overlay Manager](subMDs/frontend/overlay_manager.md) — Floating window coordination
- [Knowledge Viewer](subMDs/frontend/knowledge_viewer.md) — Read-only reference codex tab (traits/stats, recipes, items): static, data-driven, fetched once — why it lives outside the world-state flow and how it degrades

### 🌐 Networking & Communication
- [Communication & Error Handling](subMDs/networking/communication.md) — LLM integration + error codes

### 🎮 Systems & Mechanics
- [Synergy System](subMDs/systems/synergy.md) — Synergy engine + preview UI
- [Movement System](subMDs/systems/movement_system.md) — Movement mechanics
- [World Map](subMDs/systems/world_map.md) — Map visualization
- [World Map Pick-Up System](subMDs/systems/world_map_pickup.md) — Dropped items pick-up flow
- [Item Drop & Pickup System](subMDs/systems/item_drop_pickup.md) — Item drop range calculation and pickup
- [Unique ID System](subMDs/systems/unique_id_system.md) — Self-describing typed IDs (ent-, comp-, item-, eq-) for unambiguous client-server resolution
- [Crafting System](subMDs/systems/crafting_system.md) — Data-driven recipes, UI-panel crafting on a component's inventory, no turn cost
- [Energy Flow System](subMDs/systems/energy_flow.md) — Why the M1 droid circulates energy as one fully-interconnected network (simultaneous tick-start redistribution, capacity bounds with lost overflow, drains that are not damage, total degradation via one world-rule key, silent steady state, one broadcast per tick)

### 🐛 Bug Tracking
- [Bugfix Wiki](bugfixWiki/README.md) — Centralized bug database with severity classifications and resolution tracking