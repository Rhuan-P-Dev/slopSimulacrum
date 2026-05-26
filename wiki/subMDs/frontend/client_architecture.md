# Client-Side Architecture and UI

## 1. Overview

A modular vanilla JavaScript architecture using dependency injection. The main orchestrator initializes modules in a specific order, wires up callbacks between them, establishes a WebSocket connection, and starts event dispatching.

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
| Component Viewer | Component detail overlay with internal component panel |
| Navigation Actions Panel | Actions overlay with multi-component selection |
| World Map View | Full-screen world map overlay with pan/zoom |
| Inventory Manager | Inventory overlay with drag-and-drop items |
| Overlay Manager | Floating window coordination (exclusive visibility, keyboard shortcuts) |
| Client Error Controller | Error resolution and formatting |

## 2. Dependency Injection Wiring Order

The orchestrator initializes core modules first, then selection and synergy controllers, then UI modules, then the overlay manager registers all panels with their config bar buttons, establishes the WebSocket connection, and finally the event dispatcher with handler callbacks.

## 3. Data Flow

User interactions flow through the event dispatcher into the selection controller, which triggers UI updates and synergy preview fetching. The action executor sends HTTP requests for action execution. Server updates flow through the WebSocket into the state manager, which triggers UI updates.

**Overlay Registration Flow**:
1. All panel controllers are instantiated
2. `OverlayManager.register()` is called for each panel with: panel ID, controller reference, config bar button ID, keyboard shortcut key
3. `OverlayManager.init()` attaches click listeners to config bar buttons, creates the shared backdrop element, and sets up keyboard shortcuts
4. Panel toggle requests go through `OverlayManager.toggle()` which ensures exclusive visibility (only one panel open at a time)

**Why centralized overlay coordination**: Previously, each panel managed its own visibility independently, allowing multiple panels to overlap. The OverlayManager enforces exclusive visibility, manages z-index stacking, provides keyboard shortcuts (1-4 for panels, Escape to close all), and click-outside dismissal via a shared backdrop.

## 4. Logger Standard

All modules use a centralized logging utility.