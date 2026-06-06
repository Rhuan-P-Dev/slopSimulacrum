# 🔪 Sharpness System

This document explains **why** the sharpness system is designed the way it is, not **how** to read the code.

## Design Philosophy

The sharpness system embodies the principle of **mutable item state**. When a knife cuts, it should lose sharpness. This state is stored **independently** from the host component's stats, allowing each equipped item instance to track its own wear-and-tear.

## Why Separate Mutable Stats from Component Stats?

Components (body parts) have persistent stats that represent their physical properties. Equipped items (knives, tools) are **consumables** that degrade over use. Merging these would mean:

1. **Loss of item identity**: A knife's sharpness would become indistinguishable from the host component's base sharpness.
2. **No per-item tracking**: If a player equips two knives sequentially, there would be no way to track that knife A has 40 sharpness and knife B has 50.
3. **No unequip/restore behavior**: Unequipping a knife should reset its sharpness to base (the knife still exists on the table with its current sharpness, not the component's stats).

## Architecture: Why Three Separate Systems?

| System | Responsibility |
|--------|---------------|
| `EquippedItemStatsController` | Tracks mutable stats (sharpness, durability) per equipped item instance |
| `HoldingCostController` | Manages equip/unequip flow, holding cost debuffs, item ownership |
| `RequirementResolver` | Resolves current stat values for requirement checking (reads from EquippedItemStatsController) |

### Why `EquippedItemStatsController` is Separate from `HoldingCostController`

`HoldingCostController` manages the **lifecycle** of equipped items (equip, unequip, transfer). `EquippedItemStatsController` manages the **mutable values** of those items. Separating these means:

- The lifecycle controller doesn't need to know how stats are calculated
- The stats controller doesn't need to know about item ownership
- Each can be tested, modified, and extended independently

### Why Stats Flow Through `RequirementResolver`

RequirementResolver is the **gateway** between the action system and stat values. It reads from EquippedItemStatsController when a component has an equipped item, ensuring that:

1. Requirements always reflect **current** stats, not base stats
2. The action system is decoupled from the stats storage
3. Replacing EquippedItemStatsController with a different implementation wouldn't require changing RequirementChecker.js

## Sharpness Drain Flow

When the `cut` action executes:

1. **Requirement**: `Physical.sharpness >= 20` is resolved from the equipped knife's mutable stats
2. **Damage consequence**: `-.Physical.sharpness` deals damage based on **current** sharpness
3. **Sharpness drain**: `updateComponentStatDelta` on `self` with value `-1` drains the knife's sharpness
4. **Callback**: `EquippedItemStatsController._notifyStatChange` triggers capability re-evaluation
5. **Broadcast**: Updated state is sent to the client

### Why "Self" Target Routes to the Equipped Item

The `self` target in the cut action's sharpness drain consequence resolves to the **equipped item's eqId** (not the host component). This is because:

1. `RequirementResolver.checkComponentRequirements` finds the equipped knife and stores its eqId in `fulfillingComponents`
2. `ConsequenceDispatcher._resolveTargetForConsequence` with `targetType === 'self'` returns `fulfillingComponents[key]` which is the eqId
3. `StatConsequenceHandler._handleUpdateComponentStatDelta` receives the eqId and routes to `EquippedItemStatsController.updateStatDelta`

This ensures the knife's sharpness is drained, not the player's body part sharpness.

## Known Bugs (Fixed)

- **BUG-096**: Knife sharpness drain not working — EquippedItems lacked in-memory stats wiring
- **BUG-097**: Cut action capability cache not updating after sharpness drain — callback wiring fix
- **BUG-099**: Knife cut damage always using base sharpness (50) — consequence routing fix

See `wiki/bugfixWiki/high/` for details.