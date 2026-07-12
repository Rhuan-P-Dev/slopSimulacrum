# 🏠 RoomsController

## 1. Overview

A **State Controller** that stores room definitions and manages spatial data. It self-instantiates without dependency injection.

## 2. Data Schema

Rooms are loaded from a JSON data file. Each room has a name, description, connections, coordinates, dimensions, and runtime arrays for objects and entities.

**ID Strategy**: Logical names are mapped to internal unique identifiers. Connections are resolved from logical names to internal identifiers at initialization time.

### Why Connections Support Both String and Object Formats

Connections originally used a simple string format (`"door": "target_room"`) representing an unrestricted transition. The object format (`"door": { "target": "target_room" }`) was introduced to allow future per-connection metadata without breaking existing room definitions. Supporting both formats ensures gradual migration — rooms using string format continue functioning while new rooms can adopt the object format. The current implementation treats both formats identically, as range is computed from the entity's `Movement.move` stat client-side rather than stored on the connection.

### Why Range Does Not Live in Connection Definitions

Range is intentionally not stored on door connections. The ability to traverse space is a property of the entity, not the environment. A droid with `Movement.move: 20` can travel 20 units regardless of which door it approaches. Keeping range on the entity side (via component traits) means door definitions remain simple target references, and movement capability changes only require updating the entity's stats.

## 3. Public API

| Method | Returns | Description |
|--------|---------|-------------|
| `getUidByLogicalId` | room UID or null | Resolve logical name to UID |
| `getAll` | defensive copy | All rooms |
| `getRoom` | defensive copy or null | Single room |
| `getConnectionTarget` | target UID or null | Target room for a specific door |

All getters return defensive deep copies to prevent external mutation of internal state.

### Why getConnectionTarget is the Only Connection Accessor

The controller exposes a single accessor for connection data: `getConnectionTarget`, which returns the target room's UID. Range-related accessors were removed because range is no longer stored on connections — it is computed client-side from the entity's `Movement.move` stat. This keeps the server-side API minimal and focused on spatial topology rather than movement capabilities.

## 4. Integration

Consumed by the root state controller, world graph builder utility, and rendering systems.
