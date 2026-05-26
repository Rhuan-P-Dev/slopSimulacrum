# Overlay Manager

## Purpose

Central coordinator for all floating window overlay panels. Replaces ConfigBarManager entirely.

**Why this pattern**: Without a coordinator, each panel managed its own visibility independently, allowing multiple panels to overlap. This created visual conflicts and no way to close all panels at once.

## API

### Constructor
```javascript
const overlayManager = new OverlayManager();
```

### Registration
Panels register themselves with the manager during `App.init()`:
```javascript
overlayManager.register('component-viewer', componentViewer, 'btn-component-viewer', '1');
overlayManager.register('nav-actions', navActions, 'btn-nav-actions', '2');
overlayManager.register('world-map', worldMap, 'btn-world-map', '3');
overlayManager.register('inventory', inventory, 'btn-inventory', '4');
```

Each registration maps: panel ID → controller + config bar button + keyboard shortcut.

### Initialization
`overlayManager.init()` handles all setup:
- Creates shared backdrop element (click-outside dismissal)
- Attaches click listeners to config bar buttons
- Sets up keyboard shortcuts (1-4 toggles panels, Escape closes all)

### Toggle
`overlayManager.toggle(panelId)` ensures exclusive visibility:
- If the panel is already open → closes it
- If another panel is open → closes it, then opens the requested panel
- If no panel is open → opens the requested panel

### Close
`overlayManager.close(panelId)` closes a specific panel.
`overlayManager.closeAll()` closes all panels and hides the backdrop.

## Panel Requirements

Each panel controller must implement:
- `init()` — Gets DOM references, attaches close button listener
- `show(data?)` — Shows the panel
- `hide()` — Hides the panel
- `overlay` — Public reference to the overlay DOM element (for z-index management)

## Design Decisions

### Why exclusive visibility?
Having multiple floating panels overlap creates visual clutter and user confusion. Most panels show different aspects of the same context (entity state, actions, inventory), and only one is relevant at a time.

### Why keyboard shortcuts?
Power users need fast access to panels. Keyboard shortcuts (1-4) provide instant toggle without clicking config bar buttons. Escape provides universal close.

### Why click-outside dismissal?
The shared backdrop serves as an affordance that clicking outside the panel will close it. This matches common UI patterns users expect from overlay/modal interfaces.