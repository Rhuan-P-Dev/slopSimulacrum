# Item Drop & Pickup System

## Overview

The item drop/pickup system provides a symmetrical user experience for dropping and picking up items. Both flows share a single component-selection overlay so the player interacts with the same visual language regardless of direction. The drop flow commits a placement on the map; the pickup flow verifies range and then commits through the same selection experience.

## Design Decisions

### Why Mirror the Drop Flow for Pickup?

The pickup flow was redesigned to mirror the drop flow exactly:

1. **Consistency**: Users expect the same visual language for both operations
2. **Reduced cognitive load**: One pattern for both actions
3. **Code reuse**: A single selection overlay handles both flows, reducing duplication

### Why Not Use ComponentViewer for Pickup?

The original pickup flow used a floating component-detail window, which was inconsistent with the drop flow. The unified selection overlay instead provides a single component-selection experience, range feedback on the map, and consistent button labels and panel structure across both directions.

### Why Room-Based Item Positioning

Dropped items are associated with the room in which they were dropped, and the room identifier is used for two purposes:

- **Client-side filtering**: Dropped items are only rendered on the spatial map when the viewing entity is in the matching room. This prevents items from appearing across all rooms regardless of where they were physically dropped.
- **Server-side validation**: The pickup handler verifies that the entity attempting to pick up an item is in the same room as the item, rejecting the pickup with a clear error otherwise.

This design ensures that the visual representation (items on the map) and the logical world state (items existing in specific rooms) are aligned. Items dropped in one room are invisible and inaccessible from other rooms. See also: [Item Positioning System](item_positioning.md).

### Why a Component Is "Capable" of Drop or Pickup

Any component that carries the Physical, Movement, or Manipulation traits is considered capable of either operation. Capabilities are derived from traits rather than a separate per-action allow-list, so adding a new capable component type is a trait change, not a code change.

## UI Feedback Decisions

### Why Hover-Based Range Feedback?

Before this feature, users had no visual indication of whether a dropped item was within pickup range until they attempted to pick it up and received feedback. The hover-based range indicator provides immediate visual feedback before any commitment (click), reducing failed pickup attempts and making the pickup range conceptually tangible.

### Why the Callback Pattern for Hover Events

The hover callback pattern keeps the UI module focused on DOM event handling while the app orchestrator handles the range logic. This follows the Single Responsibility Principle — the UI layer manages the DOM and delegates meaning to the app through callbacks, rather than embedding range knowledge directly into the UI module.

### Why Green/Red Color Scheme?

The green and red colors for the range indicator align with existing range-indicator conventions: the drop action uses red for its range circle, and the pickup action uses green. The indicator adopts the same palette so users immediately associate green with "within pickup range" and red with "out of range," maintaining visual consistency across the drop/pickup experience.

## Related Files

- [DropSelectorController](public/js/DropSelectorController.js)
- [PickUpOverlayController](public/js/PickUpOverlayController.js)
- [ActionExecutor](public/js/ActionExecutor.js)
- [App](public/js/App.js)
- [EventDispatcher](public/js/EventDispatcher.js)
- [inventoryRoutes](src/routes/inventoryRoutes.js)

## Turn-Based Play (Deliberate Boundary)

Two deliberate boundaries with the turn system's planning barrier: in turn mode, the **drop** flow is routed through the turn queue (the client-side queue gate covers the drop path, so no action path silently bypasses the barrier), while **immediate pickup** remains an out-of-turn utility path by design — inventory manipulation is not round gameplay, and forcing it through the planning barrier would add latency with no fairness benefit.
