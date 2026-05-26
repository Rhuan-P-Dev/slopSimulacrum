# 📦 Holding Cost System

## Purpose

The holding cost system allows items (like knives) to impose stat requirements on the component that equips them. When equipped, the component suffers debuffs (holdingCost) but the item's traits make new actions available through the capability system.

## Design Decisions

### Why data-driven?

Holding cost definitions are stored in `data/holdingCost.json`, not hardcoded. This allows adding new equip-able items without modifying controller logic.

### Why debuffs on the host component?

The component that holds the item must bear the physical burden of carrying it. This creates meaningful trade-offs — a component with low `strength` cannot pick up heavy items.

### Why NOT merge traits into components?

Equipped items are independent action sources, NOT merged into component stats. This preserves clean separation:
- Component stats represent the component itself
- Equipped items bring their own traits for action discovery
- The capability system scans both entity components AND equipped items independently

## Data Schema

Located in `data/holdingCost.json`:

```json
{
  "knife": {
    "name": "Knife",
    "holdingCost": [
      { "trait": "Physical", "stat": "strength", "value": 3 },
      { "trait": "Physical", "stat": "durability", "value": 2 },
      { "trait": "Manipulation", "stat": "fine_controls", "value": 10 }
    ]
  }
}
```

Each `holdingCost` entry has:
- `trait` — trait category (e.g., "Physical", "Manipulation")
- `stat` — stat name (e.g., "strength", "fine_controls")
- `value` — both the **minimum requirement** AND the **debuff magnitude**

### Rules

1. **All** requirements must pass for equip to succeed
2. If the component lacks a required stat → equip denied
3. If the component's stat < required value → equip denied
4. On equip: each stat suffers a debuff of `-value`
5. On unequip: all debuffs are reversed

## Item Traits and Action Discovery

Equipped items have their own traits defined in `data/inventoryItems.json`. These traits are NOT merged into component stats. Instead, the capability controller scans equipped items independently during `scanAllCapabilities()`:

1. When an item is equipped, `HoldingCostController.equipItem()` triggers `actionController.reEvaluateEntityCapabilities()`
2. This calls `ComponentCapabilityController._scanEquippedItemsForActions(state)`
3. The method converts item traits (e.g., `sharpness: 50` from a knife) to a stats-like format
4. Item traits are checked against ALL action requirements
5. If an item satisfies an action's requirements, a capability entry is added with `_isEquippedItem: true` metadata
6. The UI renders equipped items with a 🔪 icon and orange left border

**Example**: The knife item has `Physical.sharpness: 50`. The `cut` action requires `Physical.sharpness >= 20`. Since the knife satisfies this, the `cut` action appears in the action panel with the knife listed as a capable source.

## Equip Flow

1. Client clicks "Equip" on an item with a holding cost
2. Server checks `holdingCost` requirements against component stats
3. If all pass → debuffs applied → capability controller re-evaluates → equipped item actions appear in UI
4. If any fail → equip denied with error message

## Drag-and-Drop Auto-Unequip

When an equipped item is dragged to another component via inventory drag-and-drop:

1. `_autoUnequipDraggedItem(itemId)` is called in `_onDrop()` — checks if the dragged item is currently equipped
2. If equipped → calls `POST /inventory/:entityId/unequip/:itemId` to remove debuffs and clean tracking
3. Then `_autoUnequipOnTarget(targetCompId)` is called — unequips any items already equipped on the target component
4. Finally, `POST /inventory/:entityId/move/:itemId` moves the now-unequipped item to the target component
5. Client reloads and re-renders inventory

This ensures the item is never physically moved while still tracked as equipped, preventing state inconsistency.

## Hand Swap (Transfer)

Moving an equipped item from one component to another:
1. Unequip from old component (remove debuffs)
2. Equip on new component (apply debuffs + check requirements)
3. Rollback if new component fails requirements

## API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/inventory/:entityId/equip/:itemId` | Equip item on a component |
| `POST` | `/inventory/:entityId/unequip/:itemId` | Unequip item from component |
| `POST` | `/inventory/:entityId/transfer/:itemId` | Transfer equipped item between components |
| `GET` | `/inventory/:entityId/equipped` | Get all equipped items for entity |
| `GET` | `/inventory/holding-cost-registry` | Get all holding cost definitions |

## Client Integration

The inventory UI shows Equip/Unequip buttons on items with holding costs. The button style changes based on equip status (cyan for equip, orange for unequip).

The action panel (`NavActionsPanel`) shows equipped items with:
- 🔪 knife icon prefix
- Orange left border
- `data-equipped-type` attribute

## Capability Entry Format

Equipped item capability entries have this structure:

```js
{
  entityId: "e1",
  componentId: "equipped-abc123-knife",
  componentType: "knife",
  componentIdentifier: "knife",
  score: 95,
  _resolvedRole: "source",
  _isEquippedItem: true,
  _equippedItemId: "abc123",
  _equippedItemType: "knife",
  _equippedComponentId: "hand-comp"
}
```

## Related Files

- `data/holdingCost.json` — Data definitions
- `data/inventoryItems.json` — Item traits (source for action discovery)
- `src/controllers/core/HoldingCostController.js` — Core controller
- `src/controllers/capabilities/componentCapabilityController.js` — `_scanEquippedItemsForActions()`
- `src/routes/inventoryRoutes.js` — API endpoints
- `public/js/InventoryManager.js` — Inventory UI
- `public/js/NavActionsPanel.js` — Action panel with equipped item display
- `public/css/actions.css` — Equipped item row styling