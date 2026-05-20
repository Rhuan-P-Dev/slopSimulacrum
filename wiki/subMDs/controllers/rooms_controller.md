# 🏠 RoomsController

## 1. Overview

A **State Controller** that stores room definitions and manages spatial data. It self-instantiates without dependency injection.

## 2. Data Schema

Rooms are loaded from a JSON data file. Each room has a name, description, connections, coordinates, dimensions, and runtime arrays for objects and entities.

**ID Strategy**: Logical names are mapped to internal unique identifiers. Connections are resolved from logical names to internal identifiers at initialization time.

## 3. Public API

| Method | Returns | Description |
|--------|---------|-------------|
| `getUidByLogicalId` | room UID or null | Resolve logical name to UID |
| `getAll` | defensive copy | All rooms |
| `getRoom` | defensive copy or null | Single room |

All getters return defensive deep copies to prevent external mutation of internal state.

## 4. Integration

Consumed by the root state controller, world graph builder utility, and rendering systems.