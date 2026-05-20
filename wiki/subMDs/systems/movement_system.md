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