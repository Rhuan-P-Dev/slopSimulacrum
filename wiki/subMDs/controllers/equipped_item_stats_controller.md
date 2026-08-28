# EquippedItemStatsController

## Purpose

Manages per-instance mutable stats for equipped items, tracking values like sharpness and durability independently from their host component's base stats. This enables items to degrade through use while remaining decoupled from the component they're attached to.

## Design Decisions

### Why a separate controller for equipped item stats?

Equipped items need mutable state that is **decoupled from their host component**. When a knife's sharpness is drained by the `cut` action, the drain must affect the knife — not the component it's attached to. This separation is fundamental to the equipped item architecture.

A shared stats store would cause the knife's sharpness drain to degrade the host component's equivalent stat, creating unintended side effects where using a knife also damages the droid's hand. The separate controller ensures each item type's stats affect only that item.

### Why per-instance storage instead of per-type?

Each equipped item instance maintains its own stat copy. Without per-instance storage, all items of the same type would share a single stat value — two knives in circulation would always have identical sharpness regardless of actual usage. Per-instance storage is necessary because:

- Multiple instances of the same item type can have different wear levels
- An item can be unequipped with degraded stats, stored, and re-equipped later retaining its degradation
- Consequence handlers target specific item IDs, not item types

### Why stats persist across equip/unequip cycles?

When an item is unequipped, its stats are **not** reset to base values. This preserves wear and tear across equipment changes — a damaged knife remains damaged even when stored in inventory. This design treats item degradation as a persistent property of the item instance, not a temporary effect of being equipped.

### Why stat change callbacks?

When an equipped item's stats change, downstream systems need to react without tight coupling. A callback pattern decouples `EquippedItemStatsController` from `ComponentCapabilityController` — stats changes notify listeners, and each listener chooses how to respond:

- **Capability re-evaluation**: If sharpness drops below an action's requirement threshold, the action should disappear from the available list
- **Broadcast updates**: The client needs to see the updated capability state

### Why defensive copying on all getters?

Per project rules, state controllers must return deep copies to prevent external mutation. Callers receive snapshots of the internal state that they can freely modify without affecting the controller's actual data.

## Public Methods

The public surface splits into mutation and inspection: initializing a newly equipped item's stats from its definition, applying stat changes (additive or absolute), and reading stats back (per-item, all items, or presence checks). All reads return defensive copies.

## Integration Points

| Controller | Why it interacts |
|------------|------------------|
| **HoldingCostController** | Owns the equip/unequip flow, so it initializes per-instance stats when an item enters a slot |
| **StatConsequenceHandler** | Routes stat consequences to the right store, so damage lands on the equipped item — not its host component |
| **ComponentCapabilityController** | Reads live item stats during capability scans, so degraded items gain or lose capabilities correctly |
| **WorldStateController** | Wires the stat-change callback that fans out capability re-evaluation and client broadcast |

## Validation

Item definitions are validated on construction and rejected outright if malformed, so the stats store can never be seeded with corrupted data — per the project's validation pattern, which fails fast before bad data is trusted.

## Related

- Related wiki: `wiki/subMDs/data/holding_cost.md` — Holding cost system (equips items, initializes stats)
- Related wiki: `wiki/subMDs/data/inventory_system.md` — Inventory system (items with traits)
- Related wiki: `wiki/subMDs/controllers/capability_controller.md` — Capability controller (consumes item stats for scoring)
- Related controller: `HoldingCostController`, `StatConsequenceHandler`, `ComponentCapabilityController`
- Related data file: `data/inventoryItems.json`