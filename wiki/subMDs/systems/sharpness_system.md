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

## Sharpness Drain — Why It's Routed to the Item

When the `cut` action executes, it consumes the equipped knife's sharpness (draining it a small fixed amount per use) and deals damage based on the knife's **current** sharpness — so a worn knife requires less to start cutting and does less as it dulls. The drain is applied to the **equipped item's** stat store, not the host component's, because the knife is the consumable that degrades: the "self" target in the drain resolves to the item that fulfilled the requirement, ensuring the knife's sharpness is drained, not the player's body-part sharpness. The stat change triggers a capability re-evaluation so the action's requirements reflect the new sharpness immediately.

## Known Bugs (Fixed)

- **BUG-096**: Knife sharpness drain not working — EquippedItems lacked in-memory stats wiring
- **BUG-097**: Cut action capability cache not updating after sharpness drain — callback wiring fix
- **BUG-099**: Knife cut damage always using base sharpness (50) — consequence routing fix

See `wiki/bugfixWiki/high/` for details.