# Client-Side Architecture and UI

## 1. Overview

A modular vanilla JavaScript architecture using dependency injection. The main orchestrator owns module initialization, callback wiring between modules, the WebSocket connection to the server, and event dispatch.

**Modules**:
| Module | Responsibility |
|--------|---------------|
| World State Manager | State synchronization with server, entity tracking |
| UI Manager | DOM and SVG rendering, action list display |
| Action Executor | All action execution handlers |
| Action Manager | Client-side action coordination |
| Selection Controller | Component selection state, cross-action locking |
| Synergy Preview Controller | Synergy preview fetching, caching, range calculation |
| Event Dispatcher | WebSocket and DOM event listeners |
| Stat Bars Manager | Configurable stat bar visualization |
| Component Viewer | Component detail overlay with internal component panel and a read-only carried-items list |
| Navigation Actions Panel | Actions overlay with multi-component selection |
| World Map View | Full-screen world map overlay with pan/zoom |
| Inventory Manager | Inventory overlay with drag-and-drop items; client-local filter state (contains-item toggle + name search) applied as a pure derivation inside the render path — a view-only concern that never mutates, persists, or pushes state |
| Drop Selector Controller | Drop component selection floating window |
| Overlay Manager | Floating window coordination (exclusive visibility, keyboard shortcuts) |
| Client Error Controller | Error resolution and formatting |
| Turn Controller | Turn HUD (round/phase — no countdown: planning is unlimited), per-round queue list, ready/lock-in control, and barrier status (ready count, who is still planning; when and why planning closed) |
| Knowledge Panel | Read-only reference codex overlay (trait/stat derivation chain, recipes, item types) — static registries fetched once per session; no world-state dependency, degrades to per-section empty states or an in-panel error card |

**State-Derived HUD Rule**: Every state-derived HUD element must default hidden/off in the static markup and be opted in by its renderer once the first relevant server state arrives — never the reverse — so a stale or half-initialized UI state can never be visible before the server has spoken.

## 2. Dependency Injection Wiring

The orchestrator is the single place that owns module construction and dependency injection. Initialization respects dependency availability — a module only receives already-initialized instances of the modules it depends on. Centralizing wiring in the orchestrator means no module needs to know about, or import, its own dependencies.

**Drop Selector Wiring**: The `InventoryManager` receives its drop selector reference from the orchestrator rather than constructing it itself. This keeps the two modules decoupled — the inventory routes drop requests through the shared selection flow without importing the selector directly.

## 3. Data Flow

User interactions flow through the event dispatcher into the selection controller, which triggers UI updates and synergy preview fetching. The action executor sends HTTP requests for action execution. Server updates flow through the WebSocket into the state manager, which triggers UI updates.

**Why the drop flow spans multiple modules**: Each part of the drop interaction owns a distinct concern — the inventory owns item selection, the drop selector owns target-component selection, the world map owns location selection, and action execution dispatches the final request. Splitting the flow this way keeps each module single-responsibility, and the server remains the authority on whether a drop is valid.

**Overlay Registration**: Each panel registers itself with the OverlayManager rather than managing its own visibility. Registration gives the manager a single coordination point: it owns the config bar button listeners, keyboard shortcuts, and shared backdrop for all registered panels, so panel controllers never need to know about each other.

**Why centralized overlay coordination**: Previously, each panel managed its own visibility independently, allowing multiple panels to overlap. The OverlayManager enforces exclusive visibility, manages z-index stacking, provides keyboard shortcuts (1-4 for panels, Escape to close all), and click-outside dismissal via a shared backdrop.

## 4. Keyboard Shortcuts

**Why keyboard shortcuts exist for overlay management**: The config bar panels (actions, inventory, synergy, etc.) are managed by the OverlayManager, which provides keyboard shortcuts for rapid access without mouse navigation. Shortcuts 1-4 toggle specific panels, and Escape closes all panels.

**Why the Alt key restores the previous action**: After executing an action, all selections are cleared and the user is left without an active action. The Alt key shortcut restores the previously active action, enabling rapid re-execution of the last action or quick alternation between two actions. This improves workflow efficiency by eliminating the need to navigate back through the UI to re-select an action that was just used.

## 5. Logger Standard

All modules use a centralized logging utility.

## 6. Component Viewer

The Component Viewer overlay displays all components of a selected entity as interactive cards, each showing stat badges grouped by trait. It supports adding stat bars from individual components, expanding internal components, and opening the stat bar add dialog pre-filled with specific stat values.

### Read-Only Carried-Items List

Each component card also renders the inspected entity's items hosted on that component as a read-only list, recovered from the flat `entity.items` array (an item's `hostComponentId` polymorphically names its parent — a component id for a top-level item or a container item id for a nested item). The render is pure: it groups children from the shared world-state array without ever mutating the item instances, so it is safe to run on live state and degrades cleanly to nothing when an entity carries no items or an item type is unknown. This is what makes a spawned NPC's server-applied loadout visible in the UI — the items always reached the client, but no surface previously rendered `entity.items` for a non-player droid.

**Why the inspection target is resolved by the orchestrator**: the Component Viewer can inspect *any* entity, but `WorldStateManager.getActiveDroid()` never resolves to an NPC blueprint such as `killerLlmDrone` (the active droid is always the incarnated player or a `smallBallDroid`). The orchestrator (App) therefore owns the "inspect this entity" entry point — clicking an entity marker on the world map — and stashes the chosen entity id for the duration of that viewing; the stash is cleared when the panel is hidden, and the data factory additionally falls back to the active droid if the inspected entity has since despawned, so the config-bar button always means the active droid. Keeping that decision in the orchestrator leaves the panel stateless about *which* entity it is showing and stops the panel from reaching into world-state heuristics to guess the user's intent.

### Trait Interaction Pattern

Stats within each component card are visually grouped by trait. Each trait group consists of a trait label and its associated stat badges contained within a dedicated container. This grouping enables two complementary interaction modes:

**Hover-to-hide**: Hovering over a trait label temporarily hides the stats for that trait while the mouse remains over the label. The design rationale is to allow users to scan component cards without visual distraction from stats they are not currently interested in, simply by moving their cursor over the trait name.

**Click-to-collapse**: Clicking a trait label permanently toggles the collapse state for that trait's stats until clicked again. This enables focused inspection of individual traits within a component — a user can collapse all traits except the one they are analyzing, reducing cognitive load when evaluating complex components with many stats across multiple traits.

**Why this interaction pattern was chosen**: Component cards can display dozens of stats across multiple traits simultaneously. Showing all stats at once creates visual clutter that makes it difficult to focus on specific trait values. The hover-to-hide pattern provides a low-friction way to temporarily declutter without committing to a state change. The click-to-collapse pattern provides a persistent decluttering mechanism for deep inspection. Together, they form a progressive disclosure pattern that scales well as component complexity increases.

**Why separate containers per trait**: Each trait group uses a dedicated container element separating the label from its stats. This architectural decision enables independent state management of visibility and collapse per trait, without requiring complex index tracking or shared state across sibling traits. It also simplifies CSS styling since each group can be styled and animated independently.