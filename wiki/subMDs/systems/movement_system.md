# 🗺️ Movement System

## 1. Overview

Movement actions execute via the action system: user selects an action, clicks a target on the map, the server calculates delta movement, and a delta-spatial consequence applies the movement.

### Room Transitions

Three methods to move between rooms:
1. **World Map overlay** — click a room node
2. **Connection arrow** — click an arrow on the spatial or world map
3. **Direct move** — programmatic room change

The target room is resolved via a room lookup service that maps logical room names to internal IDs.

## 2. Movement Calculation

The entity moves toward the clicked target by a distance determined by its movement stat:
- Click within range → entity lands on target
- Click beyond range → entity moves the stat's distance toward target

**Move action**: distance equals the movement stat value.
**Dash action**: distance is double the movement stat but costs durability.

## 3. Component Resolution

When an entity has multiple components of the same type, an explicit target component ID determines which component's stats are used for speed and which takes any durability cost.

Delta-spatial consequences always target the entity, not individual components.