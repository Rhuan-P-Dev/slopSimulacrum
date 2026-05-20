# 📚 Wiki Sub-Documentation Index

This is the master index for all sub-documentation in `wiki/subMDs/`. Files are organized into 6 categories for easy navigation.

---

## 🏛️ Architecture & System Design

System-level architecture documents describing the overall design, data flow, and communication patterns.

| Document | Description |
|----------|-------------|
| [System Architecture Map](architecture/system_map.md) | Deep-detailed system architecture, controller hierarchy, responsibility matrix |
| [Server-Client Architecture](architecture/server_client_architecture.md) | Client-server communication architecture (REST + WebSocket) |
| [Server Splitting Architecture](architecture/server_splitting.md) | Server-side splitting/multiplayer architecture |
| [Action System](architecture/action_system.md) | Action registry-based pipeline architecture |

---

## 🧩 Controllers

Controller-specific documentation including design patterns, component management, and consequence handling.

| Document | Description |
|----------|-------------|
| [Controller Patterns](controllers/controller_patterns.md) | **Mandatory** controller design patterns (DI, root injector, defensive copying) |
| [Capability Controller](controllers/capability_controller.md) | Component capability cache + scoring system |
| [Component Selection](controllers/component_selection.md) | Component selection controller |
| [Config Bar Manager](controllers/config_bar_manager.md) | Config bar UI manager |
| [Rooms Controller](controllers/rooms_controller.md) | Room management |
| [World State Manager](controllers/world_state_manager.md) | Client-side state synchronization |
| [Consequence Handler Architecture](controllers/consequence_handler_architecture.md) | Consequence dispatch system |

---

## 💾 Data Models

Data definitions for entities, components, traits, and world state.

| Document | Description |
|----------|-------------|
| [Components & Entities](data/components_and_entities.md) | Entity system + internal components (volume-based capacity, repair system) |
| [Traits](data/traits.md) | Trait system |
| [World State](data/world_state.md) | World state data model |

---

## 🖥️ Frontend & UI

Client-side architecture, UI components, and CSS organization.

| Document | Description |
|----------|-------------|
| [Client Architecture](frontend/client_architecture.md) | Client-side architecture + UI overview (13 modules, DI wiring, data flow) |
| [Client Action Execution](frontend/client_action_execution.md) | Client action execution flow |
| [CSS Architecture](frontend/css_architecture.md) | Modular CSS organization (10 single-responsibility files) |

---

## 🌐 Networking & Communication

Network protocols, LLM integration, and error handling.

| Document | Description |
|----------|-------------|
| [Communication & Error Handling](networking/communication.md) | LLM integration + error code standards (server, internal component, client) |

---

## 🎮 Systems & Mechanics

Game mechanics, visualizations, and feature systems.

| Document | Description |
|----------|-------------|
| [Synergy System](systems/synergy.md) | Synergy engine + preview UI (scaling curves, application, evaluation paths) |
| [Movement System](systems/movement_system.md) | Entity movement via action system |
| [World Map](systems/world_map.md) | Spatial visualization (room connections + world map overlay) |

---

## 📊 Quick Stats

| Metric | Count |
|--------|-------|
| Total documents | 21 |
| Categories | 6 |
| Architecture docs | 4 |
| Controller docs | 7 |
| Data model docs | 3 |
| Frontend docs | 3 |
| Networking docs | 1 |
| Systems docs | 3 |