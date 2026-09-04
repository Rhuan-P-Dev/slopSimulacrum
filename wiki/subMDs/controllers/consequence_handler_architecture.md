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
| `damageComponent` | `DamageConsequenceHandler` | Channel-based component/item damage — the raw value is split across the damage channels by the attacker's material, each slice resisted by the target's own resistance to that channel; legacy trait/stat delta when no channel is set |
| `log` | `LogConsequenceHandler` | Server-side logging |
| `triggerEvent` | `EventConsequenceHandler` | Event triggering |
| `spatial` | `SpatialConsequenceHandler` | Delta movement and spatial translation |
| `dropItem` | `DropItemHandler` | Item dropping on the world map |
| `pickUpItem` | `PickUpItemHandler` | Item pickup from the world map |
| `consumeItemAndDamage` | `ConsumeItemHandler` | T1 weapon ammo consumption — consumes an item from the T1's internal inventory, with the consumed item's volume determining the damage magnitude |
| `dropMaterialChunk` | `MaterialChunkDropHandler` | Material chunk drop on punch — consumes the applied loss published by the damage step and writes a pickable chunk per dropped material (no item-registry entry); now also runs a deterministic torn-material step (world-rules layer) that mints X% of the applied loss as additional chunk tokens gated by the shared minChunkVolume floor. No new consequence type was added: the trigger set is exactly the actions that already declare the drop step (WR-6) |

### damageComponent Consequence Type

The `damageComponent` consequence is the single choke point for channel-based damage — punch, cut, and shootT1 all converge here. It carries a damage channel and a raw value; the raw value is split across the damage channels by the **attacker's** material composition, each resulting slice is reduced by the target's own resistance to that channel, and the total is applied as one existence delta. The attacker decides *which channels* a hit lands on (a wooden fist blunts and shreds, an iron fist is pure impact); the target resists *each of those channels independently*.

The channel model is the primary path. A consequence that carries no channel falls back to the legacy trait/stat delta (damage scaled by the attacker's traits rather than hardcoded numbers) — that fallback is left intact so back-compat actions behave exactly as before. When the target is an equipped item, damage is applied to the item's per-instance stats instead of the host component — so a knife degrades from cutting, not the droid's hand.

## Equipped Item Routing

Stat consequences that target an equipped item are routed to the item's per-instance stats instead of the host component's stats. This routing ensures:

- Sharpness drain from the `cut` action affects the knife's tracked stats, not the host component
- Durability degradation from damage consequences targets the correct item instance
- Multiple item instances maintain independent stat values across equip/unequip cycles

Stat changes on equipped items also trigger capability re-evaluation, so the UI reflects the updated capability state.

## Cross-Consequence Data Flow

A consequence can publish a *result* into the shared dispatch context, and the dispatcher's parameter propagation carries it to later consequences in the same action. The damage step uses this to hand the **applied loss** to the `dropMaterialChunk` step that runs after it, so the drop derives its chunk volumes from the damage that actually left the target rather than recomputing it. This is the established way one consequence feeds another within a single action — a one-way hand-off of an already-computed result — and it is why the drop handler never re-derives damage. On the multi-attacker path, full parameter propagation is still disabled (no *other* handler-modified param ever crosses consequences there), but the reserved published-loss key is one deliberate exception: it is carried forward only inside each attacker's isolated context, so each fist's drop step consumes its own loss and drops its own chunks — never an aggregate (spec D11, revised).

## Benefits

1. **SRP Compliance**: Each module has one reason to change
2. **Testability**: Individual handlers tested in isolation
3. **Maintainability**: Changes to one type don't risk others
4. **Backward Compatibility**: Existing handler map access unchanged
