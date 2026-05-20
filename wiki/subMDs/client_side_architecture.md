# Client-Side Architecture

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
| Config Bar Manager | Top config bar, overlay coordination |
| Client Error Controller | Error resolution and formatting |

## 2. Dependency Injection Wiring Order

The orchestrator initializes core modules first, then selection and synergy controllers, then UI modules, then the action executor with a refresh callback, wires the config bar to all modules, and finally establishes the WebSocket connection and event dispatcher with handler callbacks.

## 3. Data Flow

User interactions flow through the event dispatcher into the selection controller, which triggers UI updates and synergy preview fetching. The action executor sends HTTP requests for action execution. Server updates flow through the WebSocket into the state manager, which triggers UI updates.

## 4. Logger Standard

All modules use a centralized logging utility.