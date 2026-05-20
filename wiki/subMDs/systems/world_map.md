# 🌐 World Map System

## 1. Overview

Two levels of spatial visualization:
1. **In-room connection arrows** — directional arrows on the spatial map showing adjacent rooms
2. **Full world map overlay** — toggleable overlay showing all rooms as nodes with pan/zoom

## 2. Server Side

A world graph builder utility constructs a navigable graph from room data. An endpoint serves the world graph with resolved room names.

## 3. Client Side

### Room Connection Arrows (In-Map)

SVG arrows with labels are drawn edge-to-edge between rooms. Connections are clickable via invisible hit-area elements.

### World Map Overlay

The world map view fetches the graph from the server, renders all rooms as labeled rectangles, highlights the current room, and supports pan/zoom. Clicking a room triggers a callback that moves the player's entity there.

**Pan/Zoom**: Uses a threshold for pan movement, skipping panning on interactive elements.

## 4. CSS Classes

| Class | Purpose |
|-------|---------|
| `.room-connection-line` | Clickable connection arrow |
| `.room-connection-arrow` | Arrowhead |
| `.room-connection-label` | Label text |
| `.world-map-overlay` | Overlay container |
| `.world-map-room-node` | Room node |
| `.world-map-connection-line` | World map connection |