# Dropped Items on World Map — Pick-Up System

## Why This System Exists

Players need a visual way to locate dropped items on the world map and perform pick-up actions using available components. Previously, dropped items were stored server-side but had no client-side representation or pick-up mechanism.

## Design Decisions

### Why blue squares?

- Blue provides high contrast against the dark map background and neon-green room markers
- Squares are distinct from circular entity markers and rectangular room nodes
- The marker size is large enough to see but doesn't overwhelm room markers

### Why mirror the drop flow for pick-up?

The pick-up flow was redesigned to reuse the shared component-selection overlay (same overlay, same component selection, same range indicator) for consistency:

1. **User experience**: Same visual language for both drop and pick-up
2. **Code reuse**: Single component selection overlay instead of duplicating in a separate viewer
3. **Reduced cognitive load**: Users expect the same interaction pattern

### Why a separate overlay for the initial item info?

- The initial item info display is short-lived — the user clicks "Pick Up" to continue
- Separating info display from component selection keeps each module focused
- The info overlay acts as a one-time bridge between map interaction and the shared selection overlay

### Why Hover Preview for Range?

Hover preview complements the click-based pickup flow through progressive disclosure: hovering reveals the range circle without triggering any action, while clicking commits to the pickup flow. This separation of concerns between exploration (hover) and commitment (click) allows users to visually assess range before interacting, reducing confusion about why a pickup might fail.

### Why Distinct Visual Styling for Hover Indicators?

The hover indicator uses different visual styling (lower opacity, thinner stroke, different dash pattern) from active action indicators to clearly distinguish between exploratory feedback and committed actions. Without this distinction, users might confuse the hover preview with an active drop/pickup range indicator, leading to uncertainty about whether an action is currently in progress.

## Coordinate Systems (Why Two Exist)

The world map uses **room-space coordinates** — absolute values that match the room definitions in the data files — while the main game canvas uses **center-relative coordinates** (offset from the view center). The two systems coexist because each view optimizes for a different thing: the map aligns markers directly with room geometry without a transform, while the canvas renders entities relative to the view center. The pick-up click handler therefore reads raw SVG coordinates so the point it reports matches the room-space system the map already uses. (A mismatch between these two coordinate systems was the root cause of [BUG-082](../../bugfixWiki/high/BUG-082-dropped-items-render-off-screen.md).)

## Related Files

- [PickUpItemHandler](src/controllers/consequences/PickUpItemHandler.js)
- [inventoryRoutes](src/routes/inventoryRoutes.js)
- [WorldMapView](public/js/WorldMapView.js)
- [PickUpOverlayController](public/js/PickUpOverlayController.js)
- [DropSelectorController](public/js/DropSelectorController.js)
- [ActionExecutor](public/js/ActionExecutor.js)
- [App](public/js/App.js)
- [EventDispatcher](public/js/EventDispatcher.js)

## Cluster Clicks (Group Pick)

The click step above has one data-driven branch: when the clicked marker sits in a **cluster** (>= `minItems` dropped items within the cluster `radius`, both from `data/actions.json` `pickUpItem.groupPick`), the click opens the **Group Pick window** instead of the single-item overlay. The window stacks the cluster by type with quantity steppers and a search filter; its Execute re-enters the flow above at the component-selection step, and the batch then fires one `POST /pick-up-item` per chosen instance on the selected component. Single-item clicks (sparse floor) run the single-item flow exactly as described above. The server-side pipeline and authority are unchanged — see [Group Pick](../frontend/group_pickup.md).
