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

The client computes effective movement range by finding the maximum `Movement.move` value across all droid components, matching the pattern in [`SynergyPreviewController.calculateRange()`](public/js/SynergyPreviewController.js:199):

```javascript
// From App._getEntityMovementRange()
let maxMove = null;
for (const comp of droid.components) {
    const stats = state.components.instances[comp.id];
    if (stats && stats.Movement && stats.Movement.move !== undefined) {
        if (maxMove === null || stats.Movement.move > maxMove) {
            maxMove = stats.Movement.move;
        }
    }
}
```

If the entity has no components with a `Movement.move` stat, range validation is skipped entirely (unrestricted movement).

## 4. Integration Points

- **RoomConnectionRenderer**: Exposes door position through hover/click callbacks. No range data is passed — the client computes it from entity stats.
- **UIManager**: Renders the range indicator circle at the entity position with the entity's movement range as radius.
- **App (click handler)**: Computes `Movement.move` range, validates distance from entity to door position before issuing the room transition request, blocking the transition with an error message if out of range.
- **App (hover handler)**: Computes `Movement.move` range on hover, displays green/red indicator based on whether the entity can reach the door.
