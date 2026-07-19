# Consequence Handler Architecture

## 1. Overview

The consequence handler system follows the **Single Responsibility Principle** with a dispatcher routing consequence types to their dedicated handlers. The dispatcher validates the target, resolves the target ID, and dispatches to the appropriate handler module.

## 2. Module Structure

A dispatcher module routes consequence types to dedicated handler modules: spatial, stat, damage, log, and event. Each handler is a separate file with a single responsibility.

## 3. Target Resolution

Every consequence in the action registry includes a target field indicating the scope of application. The dispatcher resolves this to a concrete target ID before dispatching:

| Target Scope | Resolves To |
|--------|-------------|
| Self | Source component from the action's fulfilling components |
| Target | Explicitly provided target component or entity ID |
| Entity | The source entity ID |

## 4. Handler Interface Contract

All handlers follow a common signature: they accept a target ID, a parameter object, and a context object, and return a result with success status, a message, and optional data.

**Context object** provides the handler with requirement values, action parameters, fulfilling component mappings, and synergy results.

## Supported Consequence Types

| Type | Handler Module | Responsibility |
|------|---------------|----------------|
| `updateStat` | `StatConsequenceHandler` | Direct stat assignment |
| `updateComponentStatDelta` | `StatConsequenceHandler` | Stat delta modification (additive changes) |
| `damageComponent` | `StatConsequenceHandler` | Component/item damage — applies trait-based damage to host components or equipped items |
| `log` | `LogConsequenceHandler` | Server-side logging |
| `triggerEvent` | `EventConsequenceHandler` | Event triggering |
| `spatial` | `SpatialConsequenceHandler` | Delta movement and spatial translation |
| `dropItem` | `DropItemHandler` | Item dropping on the world map |
| `pickUpItem` | `PickUpItemHandler` | Item pickup from the world map |
| `consumeItemAndDamage` | `ConsumeItemHandler` | T1 weapon ammo consumption — removes an item from the T1's internal inventory and deals damage equal to the consumed item's volume |

### damageComponent Consequence Type

The `damageComponent` consequence deals damage to a target component or equipped item using a trait-based damage value. Unlike `updateComponentStatDelta` which applies a fixed numeric delta, `damageComponent` computes damage from a trait stat (e.g., using `Physical.sharpness` as the damage magnitude).

The `value` parameter supports stat references like `:Physical.sharpness` and negated references like `-:Physical.sharpness`, enabling damage magnitudes that scale with the attacker's traits rather than using hardcoded numbers.

When the target ID matches an equipped item (detected via `EquippedItemStatsController.hasStats()`), damage is applied to the item's per-instance stats instead of the host component. This ensures a knife's durability degrades from cutting, not the droid's hand.

## Equipped Item Routing

When `StatConsequenceHandler` processes a stat modification, it checks whether the target ID belongs to an equipped item via `this.equippedItemStats.hasStats(targetId)`. If true, the update is routed to `EquippedItemStatsController.updateStatDelta()` instead of modifying the host component's stats.

This routing ensures:

- Sharpness drain from the `cut` action affects the knife's tracked stats, not the host component
- Durability degradation from damage consequences targets the correct item instance
- Multiple item instances maintain independent stat values across equip/unequip cycles

After the stat change, `EquippedItemStatsController` fires a callback that triggers capability re-evaluation, ensuring the UI reflects the updated capability state.

## Benefits

1. **SRP Compliance**: Each module has one reason to change
2. **Testability**: Individual handlers tested in isolation
3. **Maintainability**: Changes to one type don't risk others
4. **Backward Compatibility**: Existing handler map access unchanged
