# 🌍 World State Management

## 1. Overview

The WorldStateController is the **Root Injector** — the single source of truth for the simulation. It aggregates state from sub-controllers behind a single public surface, so the rest of the system reads one consistent view instead of reaching into individual sub-controllers.

## 2. Architecture

```
Server → WorldStateController → [subControllers: rooms, entities, components, internalComponents, actions, capabilities, synergy, selections]
```

Injection follows a bottom-up order from leaf state controllers up to coordinating logic controllers, so every controller is wired with dependencies that already exist.

## 3. RoomsController ID Strategy

Rooms are authored with logical names but addressed at runtime by internal unique identifiers. The mapping exists so data files stay human-readable while the engine works with stable IDs, and connections between rooms are resolved through this mapping at initialization time.

## 4. WorldGraphBuilder

Room definitions are stored as a flat list, but the world map needs a navigable adjacency structure. A dedicated builder derives that graph from rooms data so the map endpoint can serve navigation-ready data, keeping graph-construction logic out of the state controller.

## 5. Internal Components in State

The aggregated state includes internal components, and their periodic effects surface through the same stat-change broadcast path as any other stat modification — one synchronization channel instead of a separate effect event.

## 6. Dropped Items State

Dropped items — items removed from entity inventories and placed into the world — are stored in a centralized dropped-items collection within the WorldStateController rather than scattered across room objects (see [Inventory System — Dropped Items](inventory_system.md)). Each record carries enough to relocate and re-identify the item in the world: where it sits (spatial coordinates and the room it was dropped in) and what it is (its type, instance identity, and metadata resolved from the item definition).

The room reference on each dropped item enables room-filtered queries, allowing clients to display only the items that are relevant to the entity's current room. It also serves as the basis for spatial validation during pickup operations, ensuring entities can only interact with items in their current room.
