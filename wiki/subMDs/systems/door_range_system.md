# Door Range System

## 1. Overview

The door range system enforces spatial proximity requirements for room-to-room transitions through doors. A player can only pass through a door when their entity's `Movement.move` stat is sufficient to reach the door's position. The range is derived from the entity's capabilities, not the door's configuration.

## 2. Design Rationale

### Why Range Comes from the Entity, Not the Door

Range is computed from the entity's `Movement.move` trait stat rather than being hardcoded on door connections for two reasons:

- **Entity-driven spatial design**: The ability to traverse space is a property of the entity, not the environment. A droid with wheels (`droidRollingBall` with `move: 20`) can travel farther than one without. Storing range on the door inverts this relationship — it implies the door decides how far you can move, rather than the entity deciding what it can reach.
- **Scalability**: Adding new movement capabilities (dash, boost, synergy multipliers) only requires updating the entity's stats. Door definitions remain simple target references without needing manual range tuning per-exit.

### Why Hover Feedback Uses Green/Red Coloring

The green (in-range) / red (out-of-range) hover indicator on door connections follows the same visual language as the existing pickup and drop range indicators. Consistent color semantics across all range-based interactions reduce cognitive load — players already associate green with "action available" and red with "action blocked" from pickup/drop feedback. Reintroducing a different indicator style for doors would create unnecessary visual inconsistency.

### Why Range Validation Happens Client-Side Before Server Request

Door range is validated entirely on the client before any server request is made for two reasons:

- **Immediate UX feedback**: The player receives instant visual feedback (green/red circle) on hover, and clicks outside range are blocked before network latency. Waiting for server validation would introduce a round-trip delay before the player knows the action failed.
- **Reduced unnecessary network traffic**: Out-of-range door clicks are common when the player misjudges distance. Filtering these client-side prevents the server from processing transitions it would reject anyway.

The server still authorizes the actual room transition, but the range gate is a client-side optimization that prevents wasteful requests.

### Why the System Reuses UIManager.renderRangeIndicator

The door range indicator renders as a circle on the world map SVG, identical in structure to the pickup/drop range circles. Reusing [`UIManager.renderRangeIndicator()`](public/js/UIManager.js) avoids duplicating SVG circle creation, coordinate transformation, and cleanup logic. The only variation is the color (green/red based on distance), which is passed as a parameter — the same pattern used by action range indicators.

## 3. Range Calculation

A droid's effective reach is the best of what its parts can do — an entity with multiple locomotion components can move as far as its most capable part allows. Modeling door range this way keeps it consistent with every other range-based interaction in the game: the same movement capability that governs how far an action reaches also governs how far the entity can walk to a door.

When an entity has no movement capability at all, door range is treated as unrestricted rather than zero. A body without an explicit locomotion stat is not a body that cannot move — it is a body with no range defined to enforce, and blocking its transitions would be a false gate.

## 4. Integration Points

Door range deliberately keeps geometry and reachability separate: the map layer that draws doors only knows *where* a door is, and the reachability decision is derived from entity stats at interaction time. No range data travels with door geometry — each interaction computes reach from the live entity, so stat changes (synergy multipliers, buffs) are reflected immediately. The green/red indicator is rendered by the shared range-indicator UI, so doors speak the same visual language as pickup and drop (see §2).
