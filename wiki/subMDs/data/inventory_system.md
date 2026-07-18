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

The relationship is **1:N**: one component can hold many items, each with their own volume. Items store a `hostComponentId` reference to indicate which component contains them. **All items must be attached to a component — there is no general or unassigned inventory.**

When adding an item, `componentId` is required at every level (API, controller, and manager). If omitted, the operation fails with a clear error message.

When an entity has no items, the `items` array is absent or empty.

Items are identified by:
- `type`: The item type identifier (e.g., `powerCell`, `dataCrystal`, `testItem`)
- `id`: A unique instance ID (e.g., `item-1`, `item-2`)
- `hostComponentId`: The component ID where the item is stored

## Server-Client Data Flow

The inventory system follows a server-authoritative pattern:

1. **Registry (read)**: The client fetches item type definitions from the registry endpoint. This is static data loaded at startup.
2. **Entity items (read)**: The client fetches an entity's current items grouped by component.
3. **Add/Move/Remove (write)**: All mutations go through server API endpoints. The server validates volume constraints before allowing operations.
4. **Broadcast**: After successful mutations, the broadcast service emits updated world state to all connected clients.

This ensures that volume constraints cannot be bypassed by client-side manipulation.

## Drag-and-Drop Design Decisions

Native HTML5 Drag and Drop API is used rather than a third-party library because:

- The inventory UI is simple enough that native events suffice.
- No additional dependencies are required.
- The event model maps naturally to the drop-target pattern.

The drag-and-drop flow:
1. User drags an item card over a component's item container.
2. Client-side validation checks if the target component has room.
3. Visual feedback highlights the drop zone (green = can fit, red = cannot fit).
4. On drop, the server is asked to move the item.
5. If successful, the UI re-renders with the new item positions.

## Volume Validation Rationale

Volume validation is enforced at two levels:

1. **Client-side**: Provides immediate visual feedback during drag-and-drop without requiring server round-trips for every hover event.
2. **Server-side**: The authoritative check that determines whether the operation is actually performed.

If the client-side validation passes but the server-side validation fails (e.g., due to concurrent state changes), the server rejects the operation with a clear error message.

## Dropped Items

Dropped items — items that have been removed from an entity's inventory and placed into the world — are stored separately from inventory items in `WorldStateController._droppedItems`. Each dropped item record includes a `roomId` property that links it to the room where the item was dropped.

This design was chosen because:

- **Centralized serialization**: Keeping all dropped items in a single collection simplifies persistence and world state serialization compared to scattering items across room object arrays.
- **Room-aware rendering**: The `roomId` property enables the client to filter dropped items by the current room before rendering them on the spatial map, ensuring items only appear where they were physically dropped.
- **Spatial pickup validation**: The server uses the `roomId` to verify that an entity can only pick up items from the room it currently occupies.

Dropped items are not part of any entity's inventory. They exist as independent world entities until picked up by an entity or otherwise removed.

## Data Model

### Item Type Definitions (`data/inventoryItems.json`)

Each item type defines:
- `name`: Human-readable display name
- `description`: Item description (informational)
- `volume`: Integer volume capacity
- `traits`: Optional trait data (Physical.mass, Physical.durability)

#### Test Item

A `testItem` is included in the item registry for inventory system verification:

| Property | Value |
|----------|-------|
| `volume` | 2 |
| `mass` | 0.5 |
| `durability` | 10 |

This item is automatically added to the client entity's `centralBall` component on spawn, providing a visible test case for the inventory system's add, move, and remove operations.

### Entity Items Array

Each entity has an `items` array containing item instances:
- `id`: Unique instance identifier
- `type`: Reference to item type definition
- `name`: Display name (resolved from type)
- `volume`: Item volume (resolved from type)
- `traits`: Item traits (resolved from type)
- `hostComponentId`: Component ID where item is stored

## Architectural Placement

The inventory system follows the established patterns:

- **InventoryManager (server utility)**: Stateless computation module, not a full controller. Uses DataLoader.loadJsonSafe for data loading and Logger for logging. Defensive copying on all returns. Host component ID is mandatory.
- **WorldStateController extension**: Inventory methods follow the public API wrapper pattern — they delegate to InventoryManager and trigger broadcasts on success. Component ID is required.
- **InventoryRoutes**: Express router following the same pattern as existing route modules. Registered through the central routes index. Validates componentId in the add endpoint.
- **InventoryManager (client)**: Module following the same constructor pattern as ComponentViewer and other client modules. Uses HTML5 native Drag and Drop API.

## Drop Selector Feature

The drop selector provides a UI for dropping items from inventory onto the map. It follows this flow:

1. User clicks the "Drop" button (📦) on an inventory item card
2. A floating panel opens listing all components on the entity capable of dropping items (those with Physical, Movement, or Manipulation traits)
3. User selects one or more components and clicks "Execute Drop"
4. The panel closes, a range indicator appears on the map centered on the droid
5. User clicks a map position to drop the item there
6. The server receives the drop request and processes it via the `dropItem` consequence handler

### Server API — Capable Drop Components

The endpoint `GET /inventory/:entityId/capable-drop-components` returns all components on an entity that can perform drop actions. A component is considered "capable" if it has:

- **Physical** trait (can interact with objects)
- **Movement** trait (can carry items)
- **Manipulation** trait (fine motor control)

### Client Components

| Component | Purpose |
|-----------|---------|
| `DropSelectorController.js` | Floating window controller for component selection |
| `InventoryManager.js` | Drop button on each item card, wires to DropSelectorController |
| `App.js` | Listens for `drop-selector:execute` custom event, calculates range, stores pending drop state |
| `ActionManager.js` | `executeDropItem()` sends the actual drop request to server |

### Data Flow

```mermaid
sequenceDiagram
    participant U as User
    participant IM as InventoryManager
    participant DS as DropSelectorController
    participant App as App.js
    participant AM as ActionManager
    participant S as Server

    U->>IM: Click "Drop" button on item
    IM->>DS: show({ pendingDropItem })
    DS->>S: GET /inventory/:entityId/capable-drop-components
    S-->>DS: { components: [...] }
    DS->>DS: Render component list
    U->>DS: Select components + "Execute"
    DS->>App: CustomEvent 'drop-selector:execute'
    App->>App: Calculate drop range, show indicator
    U->>App: Click map position
    App->>AM: executeDropItem(pending, x, y)
    AM->>S: POST /actions/drop
    S->>S: DropItemHandler.handleDropItem()
    S-->>AM: Success
    AM->>App: refreshWorldAndActions()
```

## Item Stats Feature

The item stats feature allows users to view all computed stats for any inventory item by clicking a "📊 Stats" toggle button on each item card. This reveals a collapsible panel showing derived stats from multiple sources.

### Why Item Stats Are Computed Server-Side

Item stats combine data from three independent sources:
- **Base traits** from `data/inventoryItems.json` (static item definition)
- **Dynamic stats** from `EquippedItemStatsController` (mutable per-instance stats like sharpness drain, current durability)
- **Holding cost debuffs** from `HoldingCostController` (stat reductions when equipped)

Computing this on the server ensures:
- Clients cannot forge stat values to gain advantages
- The combined view always reflects the true runtime state
- Stat changes from equip/unequip are immediately reflected

### Server API — Item Stats Endpoint

The endpoint `GET /inventory/:entityId/item-stats/:itemId` returns the full computed stats for a specific item instance, organized into structured sections:

| Field | Description |
|-------|-------------|
| `_itemId` | Unique instance ID |
| `_type` | Item type identifier |
| `_name` | Display name |
| `_isEquipped` | Whether currently equipped |
| `_volume` | Item volume |
| `_baseStats` | Object of base trait values from item definition |
| `_dynamicStats` | Object of dynamic stats (only when equipped) |
| `_holdingCostRequirements` | Array of holding cost requirements (only when equipped) |
| `+ flat stat fields` | Base + dynamic merged for easy display |

**Important:** Holding cost debuffs are applied to the **component's** stats, NOT the item's. They are shown as informational requirements, not subtracted from item stats.

### Client-Side Flow

```mermaid
sequenceDiagram
    participant U as User
    participant IM as InventoryManager
    participant S as Server

    U->>IM: Click "📊 Stats" button on item
    IM->>S: GET /inventory/:entityId/item-stats/:itemId
    S->>S: Compute base traits + dynamic stats - holding cost debuffs
    S-->>IM: { success: true, stats: {...} }
    IM->>IM: Render stats grid
    U->>IM: View stats
    U->>IM: Click "📊 Stats" again
    IM->>IM: Hide stats panel (toggle)
```

### Stats Panel UI

The stats panel appears below the item card with:
- A cyan left border indicating the panel belongs to the item above
- A stats grid with stat names (cyan) and values (monospace)
- An "⚔️ Equipped" badge if the item is currently equipped
- Loading/error states for async operations

### What Stats Are Shown Per Item Type

For a **knife** item:
- `durability: 30` (base trait)
- `sharpness: 50` (base trait)

If **equipped**, additionally shows:
- `sharpness: -949` (dynamic sharpness of 50 + drain of -999)
- `durability: 30` (current dynamic durability)

For a **powerCell** item:
- `mass: 1` (base trait)
- `durability: 50` (base trait)

### Stats Data Model

The `WorldStateController.getItemStats()` method orchestrates the computation:

1. Retrieves the item instance via `InventoryManager.getItem()`
2. Flattens all numeric trait values into a base stats map
3. Checks if equipped via `HoldingCostController.isItemEquipped()`
4. If equipped, retrieves dynamic stats from `EquippedItemStatsController.getStats()`
5. If equipped, retrieves holding cost debuffs
6. Combines: dynamic stats override base stats, then holding cost debuffs are subtracted
7. Returns a flat object with metadata fields prefixed by `_`

## Nested Inventory

The nested inventory system enables items to contain other items, creating arbitrarily deep hierarchies of containers within containers. A metal box can hold power cells, a power cell can contain a data crystal, and a crate can hold a metal box — all without introducing recursive data structures.

### Why Flat Storage with Polymorphic References

The nested inventory uses a flat `entity.items[]` array rather than recursive `containedItems` arrays. All items — whether top-level or deeply nested — live in the same array. Children are discovered by querying: items whose `hostComponentId` references a parent container item ID.

This design was chosen because:

- **Single source of truth**: All items share the same storage, validation, and lifecycle logic. There is no duplicated code path for "component items" versus "container items."
- **Simplicity of discovery**: Finding all children of any host is a single filter operation on the flat array, regardless of depth.
- **Avoids deep serialization**: Recursive structures complicate serialization, change detection, and client-side diffing. A flat array is trivial to compare and transmit.
- **Polymorphic `hostComponentId`**: The same field that points to a component for top-level items also points to a parent container item for nested items. The field's meaning adapts to context — it always means "the immediate parent of this item."

### Why Volume Is Polymorphic

The `volume` property serves dual purposes depending on whether the host is a component or a container item:

- **Component volume**: Sourced from the component type definition in `data/components.json` (`traits.Physical.volume`). This represents the physical capacity of the component.
- **Container item volume**: Sourced from the item instance itself (`item.volume`). This represents the internal capacity of the container.

This polymorphism was chosen because:

- **Unified validation logic**: A single `_canChildFit(parentId, childVolume)` method works for both components and containers. The volume source is resolved dynamically based on the parent type.
- **No schema bloat**: Container items already have a `volume` property (representing their own footprint on a component). Repurposing it as capacity avoids adding a separate `capacity` field, keeping the data model minimal.
- **Natural gameplay semantics**: An item's volume naturally represents both how much space it takes up AND how much it can hold. A larger box has more volume both as an object and as a container.

### Why Cascading Deletion

When a container item is removed, all items nested within it (at any depth) are also removed. This is called cascading deletion.

This design was chosen because:

- **Physical realism**: If you remove a crate from inventory, everything inside that crate goes with it. Players do not expect items to spontaneously eject from their containers.
- **Data integrity**: Cascading deletion prevents orphaned items — items whose parent container no longer exists. Without cascading deletion, a removed container could leave its contents in an undefined state.
- **Simplicity of implementation**: A recursive walk from the removed item through its descendants handles all nesting depths with a single operation. There is no need to track containment relationships separately.

### Circular Reference Prevention

The system prevents a container from being moved into itself or any of its own descendants. This prevents infinite loops in descendant traversal and ensures the containment hierarchy remains a true tree (not a graph with cycles).

### Server-Client Data Flow for Nested Inventory

The nested inventory extends the existing server-authoritative pattern:

1. **Registry (read)**: Item type definitions are static — no change from the base inventory system.
2. **Entity items (read)**: The server returns all items in the flat array. The client groups them by `hostComponentId` and builds the tree for rendering.
3. **Add to container (write)**: The server validates volume using the container's own volume as capacity, then creates the item with `hostComponentId` set to the container's ID.
4. **Move into/out of container (write)**: The server validates capacity and prevents circular moves. The operation is a simple reassignment of `hostComponentId`.
5. **Remove with cascade (write)**: The server walks the tree from the removed item, deleting all descendants, then the item itself.
6. **Broadcast**: After any mutation, the broadcast service emits the updated world state.

### Architectural Placement

The nested inventory feature extends the existing InventoryManager without introducing new modules:

- **Server**: The same `InventoryManager` (`src/utils/InventoryManager.js`) handles both component-level and container-level operations through generic helper methods (`_getChildren`, `_getHostUsedVolume`, `_canChildFit`, `_getHostDefinition`).
- **Client**: The client-side `InventoryManager` (`public/js/InventoryManager.js`) builds the item tree from the flat server response and renders nested containers with expand/collapse toggles.
- **No new data files**: The existing `data/inventoryItems.json` schema supports nested items. Any item with a `volume` property can serve as a container — no additional type field or flag is needed.

## Related Documentation

- [Holding Cost System](holding_cost.md) — Equipped item debuffs that affect item stats
- [EquippedItemStatsController](../controllers/equipped_item_stats_controller.md) — Per-instance mutable stat tracking
- [Client Architecture](../frontend/client_architecture.md) — InventoryManager client module
- [Item Positioning System](../systems/item_positioning.md) — Room-based dropped item visibility and pickup validation
