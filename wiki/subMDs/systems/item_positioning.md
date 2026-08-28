# Item Positioning System

## Purpose

The item positioning system ensures that dropped items are associated with the specific room in which they were dropped, and that items are only visible and accessible within their originating room.

## Why Room-Based Positioning

Prior to this system, dropped items had no room association and were rendered on the spatial map regardless of which room the viewing entity occupied. This created a disconnect between the visual representation and the logical world state — items dropped in one room appeared accessible from all rooms.

Room-based positioning was introduced to align the visual layer with the spatial logic of the simulation, ensuring that items exist in the world only where they were physically dropped.

## Why Store `roomId` on the Dropped Item Directly

The design chose to store a `roomId` property directly on each dropped item record rather than moving dropped items into the room's `objects[]` array. This decision was made for three reasons:

- **Centralized serialization**: Keeping all dropped items in a single store simplifies persistence logic. Serializing one flat collection is simpler than iterating across room objects to collect scattered items.
- **Avoiding cross-controller state mutation**: Moving items into the room's object array would require the drop handler to reach into `RoomsController` state, introducing a dependency between two previously independent systems.
- **Query simplicity**: A flat dropped items store with an embedded `roomId` property allows efficient room-filtered queries without restructuring the data access layer.

## Why Room Validation Happens at Pickup Time

Room validation is enforced when an entity attempts to pick up an item, not when the item is dropped. This design was chosen because:

- **Items should persist in world state even if the dropping entity moves**: An entity that drops an item may immediately leave the room or be removed. The item should remain in the world at its drop location, accessible to other entities in the same room.
- **Spatial correctness is a pickup concern**: The act of dropping does not require spatial validation — the item is simply placed in the world. The pickup act is where spatial correctness matters, because the entity must be able to physically reach the item.
- **Decoupling drop logic from spatial constraints**: The drop handler only needs to record where the item was placed. The pickup handler is responsible for verifying that the requesting entity is in the correct room and within range.

## Data Flow Overview

The system's entire job is to bind an item to a room at drop time and to enforce that binding at pickup time. The room is recorded once, when the dropping entity's location is authoritative, and verified again only when an entity tries to pick the item up — the point at which spatial correctness actually matters.

## Relationship to Existing Systems

The item positioning system integrates with the existing drop and pickup flows without modifying their core logic. Each concern is owned by the layer best placed to enforce it:

- **Drop** captures the room context, because that is the natural moment when the dropping entity's location is known.
- **Pickup** validates room alignment, because that is where spatial correctness matters.
- **Client rendering** applies room filtering, because that is the correct boundary for visual correctness.
