# 📚 Wiki Sub-Documentation Index

This is the master index for all sub-documentation in `wiki/subMDs/`. Files are organized into 6 categories for easy navigation.

---

## 🤖 AI & Decision Systems

AI controllers, behavior registration, deterministic vs. LLM-based decision making.

| Document | Description |
|----------|-------------|
| [NPC AI Controller](controllers/npc_ai_controller.md) | Stateless, data-driven AI brain with behavior registry — `chase_attack`, capability gate, dispatch contract |

---

## 🏛️ Architecture & System Design

System-level architecture documents describing the overall design, data flow, and communication patterns.

| Document | Description |
|----------|-------------|
| [System Architecture Map](architecture/system_map.md) | Deep-detailed system architecture, controller hierarchy, responsibility matrix |
| [Server-Client Architecture](architecture/server_client_architecture.md) | Client-server communication architecture (REST + WebSocket) |
| [Server Splitting Architecture](architecture/server_splitting.md) | Server-side splitting/multiplayer architecture |
| [Action System](architecture/action_system.md) | Action registry-based pipeline architecture |
| [Attack System](architecture/attack_system.md) | Generic component-targeted attack handler — unified execution for punch, cut, and future attack types |

---

## 🧩 Controllers

Controller-specific documentation including design patterns, component management, and consequence handling.

| Document | Description |
|----------|-------------|
| [Controller Patterns](controllers/controller_patterns.md) | **Mandatory** controller design patterns (DI, root injector, defensive copying) |
| [Capability Controller](controllers/capability_controller.md) | Component capability cache + scoring system |
| [Component Selection](controllers/component_selection.md) | Component selection controller |
| [EquippedItemStatsController](controllers/equipped_item_stats_controller.md) | Per-instance mutable stat tracking for equipped items (sharpness, durability) |
| [Requirement Resolver](controllers/requirement_resolver.md) | Action requirement validation with equipped item trait resolution |
| [Component Resolver](controllers/component_resolver.md) | Source/target component resolution with priority chain and malformed ID filtering |
| [Config Bar Manager](controllers/config_bar_manager.md) | ~~Config bar UI manager~~ (Removed — replaced by OverlayManager) |
| [Rooms Controller](controllers/rooms_controller.md) | Room management |
| [World State Manager](controllers/world_state_manager.md) | Client-side state synchronization |
| [Consequence Handler Architecture](controllers/consequence_handler_architecture.md) | Consequence dispatch system |
| [Internal Component Controller](controllers/internal_component_controller.md) | State Controller pattern, unified tick system design rationale, auto-installation filtering |
| [Range Validator](controllers/range_validator.md) | Spatial range validation for proximity-based actions with failure consequences |

---

## 💾 Data Models

Data definitions for entities, components, traits, world state, and inventory.

| Document | Description |
|----------|-------------|
| [Components & Entities](data/components_and_entities.md) | Entity vs component distinction, volume-based capacity model rationale, blueprint hierarchy |
| [Holding Cost](data/holding_cost.md) | Equipped item physical burden system — holding cost traits, debuffs, equip/unequip flow, effective stats resolution |
| [Internal Components](data/internal_components.md) | Passive data-driven augmentations — tick-based effects, auto-installation filters, trait templates |
| [Traits](data/traits.md) | Trait system |
| [World State](data/world_state.md) | World state data model |
| [Inventory System](data/inventory_system.md) | Volume-based item storage on components |

---

## 🖥️ Frontend & UI

Client-side architecture, UI components, and CSS organization.

| Document | Description |
|----------|-------------|
| [Client Architecture](frontend/client_architecture.md) | Client-side architecture + UI overview (15 modules, DI wiring, data flow) |
| [Client Action Execution](frontend/client_action_execution.md) | Asynchronous execution rationale, server authority principle, selection UI purpose |
| [CSS Architecture](frontend/css_architecture.md) | Modular CSS philosophy, single-responsibility rationale, theme variable design |
| [Overlay Manager](frontend/overlay_manager.md) | Floating window coordination — exclusive visibility, keyboard shortcuts, click-outside dismissal |

---

## 🌐 Networking & Communication

Network protocols, LLM integration, and error handling.

| Document | Description |
|----------|-------------|
| [Communication & Error Handling](networking/communication.md) | LLM validation rationale, layered error handling philosophy, error classification |

---

## 🎮 Systems & Mechanics

Game mechanics, visualizations, and feature systems.

| Document | Description |
|----------|-------------|
| [Synergy System](systems/synergy.md) | Synergy scoring philosophy, scaling curve intent, preview system purpose, evaluation paths |
| [Movement System](systems/movement_system.md) | Data-driven movement rationale, action-system separation, delta spatial design |
| [World Map](systems/world_map.md) | Spatial visualization decoupling rationale, server-side graph design, two-level navigation |
| [World Map Pick-Up System](systems/world_map_pickup.md) | Dropped items on map as blue squares, hover-based range preview, pick-up overlay flow, component selection |
| [Item Drop & Pickup System](systems/item_drop_pickup.md) | Item drop range calculation, hover-based range feedback, pickup overlay flow, component targeting for dropped items |
| [Door Range System](systems/door_range_system.md) | Spatial proximity for door transitions, hover-based green/red feedback, client-side range validation before server request |
| [Unique ID System](systems/unique_id_system.md) | Self-describing typed IDs (ent-, comp-, item-, eq- prefixes) for unambiguous client-server resolution |
| [Sharpness System](systems/sharpness_system.md) | Equipped item mutable stats architecture — sharpness drain, durability, capability re-evaluation |
| [T1 Weapon System](systems/t1_weapon_system.md) | Container weapon concept — resource scaling damage, dual-volume items, spawn observer auto-assignment |
| [Hint System](systems/hint_system.md) | Deterministic hint registry — reachability-move suggestion for unreachable entities, extensible rule engine |
| [Instinct System](systems/instinct_system.md) | Runtime-generated behavior primitives for the LLM agent — one instinct call per behavior instead of per-action micromanagement; names and action lists derived live from the action registry and capabilities so the model's vocabulary stays stable and data stays clean |
| [Crafting System](systems/crafting_system.md) | Data-driven recipes, UI-panel crafting on a component's inventory — no world entity, no range, no turn consumed |

---

## 📊 Quick Stats

| Metric | Count |
|--------|-------|
| Total documents | 38 |
| Categories | 6 |
| Architecture docs | 5 |
| Controller docs | 12 |
| Data model docs | 6 |
| Frontend docs | 4 |
| Networking docs | 1 |
| Systems docs | 10 |
