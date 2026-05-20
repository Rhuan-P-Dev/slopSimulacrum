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