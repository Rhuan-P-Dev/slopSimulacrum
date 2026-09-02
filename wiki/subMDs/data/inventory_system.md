# Inventory System

## Purpose and Design Rationale

The inventory system provides a volume-based storage mechanism where droid entities can carry items across their components. Each component with a `Physical.volume` property acts as a container whose capacity limits how much total item volume can be stored within it.

This design was chosen because:

- **Volume as a shared metric**: The `Physical.volume` property already exists on component definitions in `data/components.json`, making it a natural capacity metric without introducing new properties.
- **Component as container**: Components are the natural grouping unit — items are stored on specific components, creating a 1:N relationship.
- **Server-authoritative validation**: All volume operations are validated server-side to prevent state corruption from client manipulation.

## Why Volume-Based Storage

Volume-based storage was chosen over count-based or slot-based alternatives because:

- It provides a continuous capacity model where items of varying sizes can be packed into components proportionally.
- It aligns with the existing `Physical.volume` trait, avoiding schema changes to component definitions.
- It creates meaningful gameplay decisions: small components can hold many small items, while large components can carry fewer large items.

## Component-to-Item Relationship

The relationship is **1:N**: one component can hold many items, each with their own volume. **All items must be attached to a component — there is no general or unassigned inventory.** Because no unassigned inventory exists, every item operation must identify the component that hosts the item, and operations without a host are rejected.

## Server-Client Data Flow

The inventory system follows a server-authoritative pattern: item type definitions and an entity's current items are read from the server, every mutation (add, move, remove) goes through a server-validated operation, and successful mutations are broadcast as updated world state. This ensures that volume constraints cannot be bypassed by client-side manipulation.

## Drag-and-Drop Design Decisions

Native HTML5 Drag and Drop API is used rather than a third-party library because:

- The inventory UI is simple enough that native events suffice.
- No additional dependencies are required.
- The event model maps naturally to the drop-target pattern.

## Volume Validation Rationale

Volume validation is enforced at two levels:

1. **Client-side**: Provides immediate visual feedback during drag-and-drop without requiring server round-trips for every hover event.
2. **Server-side**: The authoritative check that determines whether the operation is actually performed.

## Dropped Items

Dropped items — items that have been removed from an entity's inventory and placed into the world — are stored separately from inventory items in a centralized dropped-items collection within the WorldStateController. Each dropped item records the room where it was dropped.

This design was chosen because:

- **Centralized serialization**: Keeping all dropped items in a single collection simplifies persistence and world state serialization compared to scattering items across room object arrays.
- **Room-aware rendering**: The room reference enables the client to filter dropped items by the current room before rendering them on the spatial map, ensuring items only appear where they were physically dropped.
- **Spatial pickup validation**: The server uses the room reference to verify that an entity can only pick up items from the room it currently occupies.

Dropped items are not part of any entity's inventory. They exist as independent world entities until picked up by an entity or otherwise removed.

## Data Model

### Item Type Definitions (`data/inventoryItems.json`)

Item type definitions declare the conceptual information the inventory system needs per item: what the item is (display name and description), how much space it occupies, and the base traits it carries.

#### Test Item

A `testItem` is included in the item registry for inventory system verification. It is automatically added to the client entity's `centralBall` component on spawn, providing a visible test case for the inventory system's add, move, and remove operations.

### Entity Items Array

Each item instance stored on an entity records its type, its resolved volume and traits, and the component that hosts it. Resolving display values onto the instance makes items self-describing — they can be serialized, broadcast, and restored without re-deriving data from type definitions.

## Dynamic Item Types (No Registry Entry)

Not every item type has a row in the registry. The [material chunk drop](material_damage_and_drop.md) feature produces items whose type is *self-describing* (the material is embedded in the type name) and whose only variable is volume, which changes per drop. Such an item has **no entry in `data/inventoryItems.json`** — its definition is synthesized on the fly at the few places an item definition is looked up (pickup, add-to-inventory, re-drop, stat reporting).

This was chosen over one registry entry per material for the same reason the feature exists: the material set is open-ended, and a registry row would carry a *static* volume where a chunk's volume is *dynamic*. Because ground-item records are already self-describing, the client renders these items with no changes. This sets a precedent for the system: the registry is no longer the *only* source of an item definition — a self-describing type can stand in where the type itself names what the item is.

## Architectural Placement

The inventory system follows the established patterns:

- **InventoryManager (server utility)**: Stateless computation module, not a full controller. Uses DataLoader.loadJsonSafe for data loading and Logger for logging. Defensive copying on all returns. Host component ID is mandatory.
- **WorldStateController extension**: Inventory methods follow the public API wrapper pattern — they delegate to InventoryManager and trigger broadcasts on success. Component ID is required.
- **InventoryRoutes**: Express router following the same pattern as existing route modules. Registered through the central routes index. Validates componentId in the add endpoint.
- **InventoryManager (client)**: Module following the same constructor pattern as ComponentViewer and other client modules. Uses HTML5 native Drag and Drop API.
- **Crafting System (consumer)**: The [crafting system](../systems/crafting_system.md) is a consumer of the inventory system — crafting consumes and produces items exclusively through this InventoryManager + facade pattern; it never bypasses it.

## Drop Selector Feature

The drop selector lets a player drop an inventory item onto the spatial map: it chooses which component performs the drop and where the item lands.

A component is considered "capable" of dropping when it has the traits that let it physically interact with, carry, and release objects (Physical, Movement, Manipulation) — only such components are offered as drop sources, so the UI never presents a component that could not actually perform the action.

## Item Stats Feature

The item stats feature exposes a computed stat view for any inventory item, combining several independent stat sources into a single display.

### Why Item Stats Are Computed Server-Side

Item stats combine data from three independent sources:

- **Base traits** from `data/inventoryItems.json` (static item definition)
- **Dynamic stats** from `EquippedItemStatsController` (mutable per-instance stats like sharpness drain, current durability)
- **Holding cost debuffs** from `HoldingCostController` (stat reductions when equipped)

Computing this on the server ensures:

- Clients cannot forge stat values to gain advantages
- The combined view always reflects the true runtime state
- Stat changes from equip/unequip are immediately reflected

**Important:** Holding cost debuffs are applied to the **component's** stats, NOT the item's. In the stats view they are shown as informational requirements, not subtracted from item stats — subtracting them there would double-count a penalty that already applies to the host.

## Nested Inventory

The nested inventory system enables items to contain other items, creating arbitrarily deep hierarchies of containers within containers. A metal box can hold power cells, a power cell can contain a data crystal, and a crate can hold a metal box — all without introducing recursive data structures.

### Why Flat Storage with Polymorphic References

The nested inventory stores every item — whether top-level or deeply nested — in one flat array rather than in recursive containment structures. Children of any container are identified by the same parent reference that top-level items use to point at their host component.

This design was chosen because:

- **Single source of truth**: All items share the same storage, validation, and lifecycle logic. There is no duplicated code path for "component items" versus "container items."
- **Simplicity of discovery**: Finding all children of any host works identically regardless of depth.
- **Avoids deep serialization**: Recursive structures complicate serialization, change detection, and client-side diffing. A flat array is trivial to compare and transmit.
- **Polymorphic `hostComponentId`**: The same field that points to a component for top-level items also points to a parent container item for nested items. The field's meaning adapts to context — it always means "the immediate parent of this item."

### Why Volume Is Polymorphic

The `volume` property serves dual purposes depending on whether the host is a component or a container item:

- **Component volume**: Sourced from the component type definition in `data/components.json` (`traits.Physical.volume`). This represents the physical capacity of the component.
- **Container item volume**: Sourced from the item instance itself (`item.volume`). This represents the internal capacity of the container.

This polymorphism was chosen because:

- **Unified validation logic**: One capacity check works for both components and containers — the volume source is simply resolved from the parent's type.
- **No schema bloat**: Container items already have a `volume` property (representing their own footprint on a component). Repurposing it as capacity avoids adding a separate `capacity` field, keeping the data model minimal.
- **Natural gameplay semantics**: An item's volume naturally represents both how much space it takes up AND how much it can hold. A larger box has more volume both as an object and as a container.

### Why Cascading Deletion

When a container item is removed, all items nested within it (at any depth) are also removed. This is called cascading deletion.

This design was chosen because:

- **Physical realism**: If you remove a crate from inventory, everything inside that crate goes with it. Players do not expect items to spontaneously eject from their containers.
- **Data integrity**: Cascading deletion prevents orphaned items — items whose parent container no longer exists. Without it, a removed container could leave its contents in an undefined state.

### Circular Reference Prevention

The system prevents a container from being moved into itself or any of its own descendants. This prevents infinite loops in descendant traversal and ensures the containment hierarchy remains a true tree (not a graph with cycles).

### Server-Client Data Flow for Nested Inventory

The nested inventory extends the existing server-authoritative pattern without changing it: all items at any depth are read from the same flat collection, every mutation is validated server-side (capacity and acyclicity included), and successful mutations broadcast the updated world state. Moving an item between a component and a container is conceptually just changing which parent the item belongs to — the validation rules around that change are what make it safe.

### Architectural Placement

The nested inventory extends the existing server and client InventoryManager modules without introducing new modules or new data files. Any item type that carries a volume can serve as a container, so no additional type flag is needed in the data model.

### Dual-Volume Items: `externalVolume`

Some container items need to express two distinct volume concepts: the physical space they occupy on a host (external footprint) and the internal capacity they provide for storing other items. The `externalVolume` property enables this distinction. Items that do not define a separate footprint use their regular volume for both roles, which preserves the behavior of all existing items.

This was introduced to support the T1 weapon system, where the weapon needs a small footprint on its host component but provides significant internal storage for ammunition. Without the distinction, the T1 would need to take up as much space as it can hold, which contradicts the design intent of a compact weapon that stores its own ammo.

## Material Trait Derivation

Inventory items with a material composition receive material-derived trait stats, mirroring the component-side derivation documented in the [Materials System](materials.md). Derivation happens when an item is first created, and missing derived traits are gap-filled when a persisted world state is restored.

### Fill-Only Resync Contract

Restoration uses a **fill-only** strategy: persisted `item.traits` keys are the source of truth; only *missing* keys are filled from blueprint ⊕ material-derived values. The invariant is: "persisted item.traits is the source of truth after restore; derivation is gap-filling only; item traits are not mutated at runtime by other systems." Data re-tuning does not retroactively change already-persisted items — new items pick up new values on first spawn.

See [Materials System — fill-only gap-filling sync](materials.md) for the full fill-only contract and trade-off discussion.

## Related Documentation

- [Holding Cost System](holding_cost.md) — Equipped item debuffs that affect item stats
- [EquippedItemStatsController](../controllers/equipped_item_stats_controller.md) — Per-instance mutable stat tracking
- [Client Architecture](../frontend/client_architecture.md) — InventoryManager client module
- [Item Positioning System](../systems/item_positioning.md) — Room-based dropped item visibility and pickup validation
- [Crafting System](../systems/crafting_system.md) — consumes/produces items through the inventory system (never bypassed)
