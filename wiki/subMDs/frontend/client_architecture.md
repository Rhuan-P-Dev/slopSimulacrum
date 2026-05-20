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
| Config Bar Manager | Top config bar, overlay coordination |
| Client Error Controller | Error resolution and formatting |

## 2. Dependency Injection Wiring Order

The orchestrator initializes core modules first, then selection and synergy controllers, then UI modules, then the action executor with a refresh callback, wires the config bar to all modules, and finally establishes the WebSocket connection and event dispatcher with handler callbacks.

## 3. Data Flow

User interactions flow through the event dispatcher into the selection controller, which triggers UI updates and synergy preview fetching. The action executor sends HTTP requests for action execution. Server updates flow through the WebSocket into the state manager, which triggers UI updates.

## 4. Logger Standard

All modules use a centralized logging utility.

---

## Client UI

### 1. Overview

A cyber-terminal styled single-page application built with HTML5, CSS3, and vanilla JavaScript. The layout consists of a top config bar, a middle spatial map area, and a bottom stat bars panel.

**CSS modules**: Single-responsibility stylesheets covering base resets, layout, map visualization, navigation, actions, synergy, components, utilities, feedback, and internal components.

### 2. Layout

The top section holds the config bar with buttons for each overlay. The middle section is a flexible SVG-based spatial map displaying rooms, entities, and components. The bottom section is a fixed-height scrollable stat bars panel.

Floating overlays appear on demand: component viewer, actions panel, and world map.

### 3. Key UI Features

- **Map rendering**: SVG with rooms, entities, components, and internal components rendered as colored circles
- **Range indicators**: Color-coded circles for movement range and attack range
- **Stat bars**: Configurable, percentage-based bars colored by trait
- **Component Viewer**: Grid of component cards with an expandable internal component panel
- **Multi-component selection**: Click-to-toggle with cross-action graying and synergy preview
- **World Map overlay**: Pan and zoom navigation with clickable room connections
- **Error display**: Notification pop-ups in the corner of the screen

### 4. Styling

- **Theme**: Cyber-terminal aesthetic with a dark background and neon accent colors
- **Font**: Monospaced typeface
- **Variables**: All colors defined as CSS custom properties