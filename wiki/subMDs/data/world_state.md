# 🌍 World State Management

## 1. Overview

The WorldStateController is the **Root Injector** — the single source of truth for the simulation. It aggregates state from sub-controllers through a unified access method.

## 2. Architecture

```
Server → WorldStateController → [subControllers: rooms, entities, components, internalComponents, actions, capabilities, synergy, selections]
```

Injection follows a bottom-up order from leaf state controllers up to coordinating logic controllers.

## 3. RoomsController ID Strategy

Logical names are mapped to internal unique identifiers. Connections are resolved from logical names to internal identifiers at initialization time. A reverse lookup method provides the inverse mapping.

## 4. WorldGraphBuilder

A utility constructs a navigable graph from rooms data. Used by the WorldStateController to serve the world map endpoint.

## 5. Internal Components in State

The aggregated state includes internal components. The repair system modifies host component stats, which triggers stat change broadcast automatically.

## 6. Dropped Items State

Dropped items — items removed from entity inventories and placed into the world — are stored in a centralized dropped items collection within `WorldStateController`. Each dropped item record contains:

- A unique dropped item identifier
- The original item type and item instance ID
- Spatial coordinates (x, y) where the item was placed
- A room identifier linking the item to the room where it was dropped
- Metadata resolved from the item definition (name, description, volume)

The room identifier on each dropped item enables room-filtered queries, allowing clients to display only the items that are relevant to the entity's current room. It also serves as the basis for spatial validation during pickup operations, ensuring entities can only interact with items in their current room.

A dedicated query method provides room-filtered access to dropped items, returning only those matching a specified room identifier.
