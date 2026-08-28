# Consequence Handler Architecture

## 1. Overview

The consequence handler system follows the **Single Responsibility Principle** with a dispatcher routing consequence types to their dedicated handlers. The dispatcher is the single place that turns a declared consequence into a concrete application — resolving targets and scope — so individual handlers never re-derive action context.

## 2. Module Structure

A dispatcher module routes consequence types to dedicated handler modules. Each handler is a separate file with a single responsibility, so adding or changing one consequence type never touches the others.

## 3. Target Resolution

Consequences in the action registry declare their scope of application rather than carrying concrete target IDs, so designers can express intent like "apply to self" or "apply to the hit target" without knowing runtime identifiers. The dispatcher interprets these scopes into a concrete target before dispatch, keeping scope semantics in one place instead of scattering them across handlers.

## 4. Handler Interface Contract

All handlers share one contract so the dispatcher can route uniformly without knowing handler internals: a target, a parameter object, and a shared context that carries everything about the originating action — requirement values, action parameters, fulfilling component mappings, and synergy results. Handlers never reach back into the action pipeline, which keeps them self-contained and independently testable.

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
| `consumeItemAndDamage` | `ConsumeItemHandler` | T1 weapon ammo consumption — consumes an item from the T1's internal inventory, with the consumed item's volume determining the damage magnitude |

### damageComponent Consequence Type

The `damageComponent` consequence deals trait-based damage to a target component or equipped item. Unlike `updateComponentStatDelta`, which applies a fixed numeric delta, damage magnitudes here are expressed as trait references (e.g., the attacker's `Physical.sharpness`) so they scale with the attacker's traits rather than using hardcoded numbers.

When the target is an equipped item, damage is applied to the item's per-instance stats instead of the host component — so a knife's durability degrades from cutting, not the droid's hand.

## Equipped Item Routing

Stat consequences that target an equipped item are routed to the item's per-instance stats instead of the host component's stats. This routing ensures:

- Sharpness drain from the `cut` action affects the knife's tracked stats, not the host component
- Durability degradation from damage consequences targets the correct item instance
- Multiple item instances maintain independent stat values across equip/unequip cycles

Stat changes on equipped items also trigger capability re-evaluation, so the UI reflects the updated capability state.

## Benefits

1. **SRP Compliance**: Each module has one reason to change
2. **Testability**: Individual handlers tested in isolation
3. **Maintainability**: Changes to one type don't risk others
4. **Backward Compatibility**: Existing handler map access unchanged
