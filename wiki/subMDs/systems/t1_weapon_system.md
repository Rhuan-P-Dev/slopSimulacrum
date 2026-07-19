# T1 Weapon System

## Purpose and Design Rationale

The T1 weapon introduces a container weapon concept to the action system — an item that both occupies inventory space and contains ammunition within its own internal inventory. When fired, it consumes items stored inside itself to deal damage proportional to what it consumes.

This design was chosen over traditional weapon systems because:

- **Resource-driven damage**: Damage output scales with the value of consumed resources, creating a meaningful trade-off between firepower and inventory preservation. Players must decide whether a high-volume item is worth consuming as ammunition.
- **Self-contained weapon mechanics**: The T1 weapon does not require external ammo types or separate ammunition inventories. Its ammunition is any item already in the player's inventory system, reducing complexity in the data model while enabling emergent gameplay.
- **Inventory-action coupling**: By tying the weapon's damage to items already governed by the volume-based inventory system, the T1 creates natural gameplay tension — every item has dual value as both a resource and potential ammunition.

## Why Resource Scaling Damage

Damage based on consumed item volume was chosen over fixed or trait-based damage because:

- **Meaningful choices**: A power cell (volume 2) deals less damage than a tool crate (volume 30), but the tool crate may have other uses. This creates tactical decisions about what to sacrifice.
- **No new stat systems required**: Using volume as the damage metric leverages an existing property already present on all items, avoiding the introduction of separate "ammo power" or "projectile strength" fields.
- **Natural scaling**: Larger items naturally deal more damage because they represent more substantial physical objects being fired.

## System Architecture

### Container Items Pattern

The T1 weapon follows the container items pattern already established by the nested inventory system. Just as a metal box can hold power cells, the T1 weapon holds ammunition items within its own internal inventory. The same flat storage and polymorphic `hostComponentId` mechanism used for nested containers applies here — the T1's item ID becomes the parent reference for its ammo.

This approach was chosen because it reuses existing validation, traversal, and deletion logic rather than introducing a parallel weapon-ammo system.

### Action Integration

The `shootT1` action is registered in the action registry with a single custom consequence type: `consumeItemAndDamage`. This consequence bridges the inventory system and the damage system:

1. The consequence handler locates the T1 weapon on the attacking entity by resolving the equipped item reference.
2. It queries the T1's internal inventory for available ammunition.
3. It removes the first available ammo item and stores its volume in the action context.
4. The stored volume is then used as the damage value for the target's durability.

This design keeps the action definition declarative — the action only specifies that damage should be dealt using a resolved value, while the handler determines what that value is at runtime.

### Spawn Observer Pattern

T1 weapons are automatically assigned to newly spawned entities through the spawn pipeline. When an entity is created from a blueprint, the system searches for a suitable component to receive the T1:

- **Hand-first placement**: The system prioritizes hand components (identified by type name) for natural weapon positioning.
- **Volume-aware selection**: Only components with sufficient available volume are considered, respecting the T1's external footprint.
- **Graceful degradation**: If no hand component is available, any component with enough space receives the weapon.

This automatic assignment ensures all entities with appropriate components begin with the T1 weapon without requiring explicit blueprint configuration.

## The Dual-Volume Model

### Why Two Volume Concepts

Container items like the T1 weapon need to express two distinct volume-related properties:

- **External volume** (`externalVolume`): The physical footprint the item occupies on its host component. This is the space the T1 weapon takes up when stored on a droid's hand.
- **Internal volume** (`volume`): The internal capacity the item provides for holding other items. This is the 10-unit storage space the T1 offers for ammunition.

Without this distinction, container items face a design conflict: their volume property must simultaneously represent both their own size and their storage capacity. For the T1, having a volume of 30 would mean it takes up 30 units of space on a component while also holding 30 units of items — but the intended design is for it to take up only 1 unit while holding 10.

### How External Volume Differs From Volume

For non-container items, `externalVolume` is absent and the system falls back to `volume` as the footprint. This maintains backward compatibility — existing items like power cells, knives, and metal boxes continue to work without modification.

For the T1 weapon specifically:
- `externalVolume: 1` — takes up 1 unit of space on the host component
- `volume: 10` — provides 10 units of internal storage capacity

This asymmetry is the core design innovation that makes the container weapon concept feasible within the existing volume-based inventory system.

## Related Documentation

- [Inventory System](../data/inventory_system.md) — Volume-based storage and nested container mechanics
- [Action System](../architecture/action_system.md) — Action registry and consequence pipeline
- [Components & Entities](../data/components_and_entities.md) — Entity blueprint hierarchy and volume constraints
