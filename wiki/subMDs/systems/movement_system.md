# Movement System

## 1. Overview

Movement is the primary means of entity traversal across the game world. It is driven by player-chosen actions rather than direct state mutation, ensuring that every movement event passes through a deterministic, server-authoritative pipeline.

## 2. Design Rationale

### Why Data-Driven Movement

Movement distances are derived from entity stats (e.g., the `movement` stat) rather than hardcoded values. This allows:

- **Balance tuning without code changes**: Adjusting movement range is a stat edit, not a logic edit
- **Dynamic modifiers**: Synergy effects, buffs, or debuffs can alter movement values at runtime by changing the underlying stat
- **Predictable player experience**: The same stat always produces the same proportional result, regardless of context

### Why Movement Is Decoupled From Actions

The action system selects *what* the player wants to do; the movement system handles *how* the entity relocates. This separation exists because:

- **Shared movement behavior**: Multiple action types (Move, Dash, forced reposition) use the same underlying movement logic
- **Single responsibility**: Actions define requirements and consequences; movement only interprets and executes them
- **Extensibility**: New movement-based actions require no changes to the movement pipeline

### Why Delta Spatial Exists

Delta spatial consequences represent *relative* movement (offsets) rather than *absolute* room transitions. This distinction exists because:

- **Within-room precision**: Entities can move partial distances within a room without triggering a room change
- **Dash vs Move differentiation**: Dash doubles movement distance but adds a durability cost — a trade-off expressed through consequences, not hardcoded logic

## 3. Between-Room Movement (Door-to-Door Spawn)

### Why Door-to-Door Spawn Exists

When an entity traverses a room connection through a door, it should spawn at the position of the *opposite* door in the destination room. This exists because:

- **Spatial continuity**: Entities retain stale spatial coordinates (usually `0,0`) after room transitions without explicit positioning
- **Intuitive navigation**: Exiting through a `right_door` should place the entity at the `left_door` of the next room, maintaining directional flow
- **Single source of truth for position**: Door positions are derived from room layout data rather than manually stored, eliminating data duplication and maintenance burden

### Why Door Positions Are Calculated, Not Stored

Door positions are **derived automatically from room geometry** rather than stored, because:

- **Zero maintenance**: Positions update automatically when room geometry changes
- **Single source of truth**: Room dimensions are the only data needed; positions are derived, not duplicated
- **Client-server parity**: Both sides derive positions from the same geometry, preventing visual mismatches between rendered connections and spawn points
- **No drift**: Stored positions can become stale when room layouts change; derived positions cannot

### Why Position Overrides Are Optional

The explicit position on a connection is **optional** and exists only for intentional overrides. Non-standard doors — interior portals, floating entrances, or any door that does not sit on the geometric edge — cannot be derived from room geometry, so they carry an explicit position that takes precedence over the derived value.

### Why a Graceful Spawn Fallback

If the ideal opposite-door position in the destination room cannot be resolved (missing geometry, no matching reverse connection), the traversal still succeeds: the system degrades to inferring the entry edge from door-name conventions when it can, and otherwise spawns the entity at the room center. A room transition should never fail because a spawn point is unavailable — landing somewhere sensible in the destination room is always preferable to a blocked transition.

### Why Legacy Connection Data Keeps Working

Existing room data that describes a connection as just a target (no position) remains valid without a migration, and now benefits from automatic position calculation. When a traversal request does not name the source door, the entity simply spawns at the destination room's center, preserving the long-standing default behavior.
