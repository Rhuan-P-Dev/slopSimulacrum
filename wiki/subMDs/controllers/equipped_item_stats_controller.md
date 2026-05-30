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

| Method | Purpose |
|--------|---------|
| `initializeStats(itemId, itemType)` | Loads base stats from inventory item definitions for a newly equipped item |
| `updateStatDelta()` | Applies an additive stat change to an equipped item |
| `updateStat()` | Sets a stat to an absolute value on an equipped item |
| `getStats()` | Returns a deep copy of stats for a specific item |
| `getAll()` | Returns a deep copy of all tracked item stats |
| `hasStats()` | Checks whether a given item ID has tracked stats |

## Integration Points

| Controller | Relationship |
|------------|-------------|
| **HoldingCostController** | Passes `equippedItemStats` via constructor DI during initialization |
| **StatConsequenceHandler** | Routes damage consequences to equipped items via DI |
| **ComponentCapabilityController** | Reads current stats during capability scans to score equipped item actions |
| **WorldStateController** | Wires the stat change callback to trigger capability re-evaluation and broadcast |

## Validation

On construction, item definitions are validated to ensure structural integrity:

- Item definitions must be valid objects
- Each item must have a non-empty `name`
- If `traits` exists, it must be a valid object with numeric stat values
- Non-numeric trait properties are silently ignored

Invalid definitions throw `TypeError`, preventing corrupted data from entering the stats store.

## Related

- Related wiki: `wiki/subMDs/data/holding_cost.md` — Holding cost system (equips items, initializes stats)
- Related wiki: `wiki/subMDs/data/inventory_system.md` — Inventory system (items with traits)
- Related wiki: `wiki/subMDs/controllers/capability_controller.md` — Capability controller (consumes item stats for scoring)
- Related controller: `HoldingCostController`, `StatConsequenceHandler`, `ComponentCapabilityController`
- Related data file: `data/inventoryItems.json`