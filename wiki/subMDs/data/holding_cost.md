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

Holding cost definitions are stored in `data/holdingCost.json`. Each entry defines an item type's holding cost as an array of stat requirements:

Each `holdingCost` entry specifies a `trait` category (e.g., "Physical", "Manipulation"), a `stat` name (e.g., "strength", "fine_controls"), and a `value` that serves as both the **minimum requirement** AND the **debuff magnitude**.

### Rules

- **All** requirements must pass for equip to succeed
- If the component lacks a required stat or its stat is below the required value → equip denied
- On equip: each stat suffers a debuff of `-value`
- On unequip: all debuffs are reversed

## Item Traits and Action Discovery

Equipped items have their own traits defined in `data/inventoryItems.json`. These traits are NOT merged into component stats. Instead, the capability controller scans equipped items independently during `scanAllCapabilities()`. When an item is equipped, `HoldingCostController.equipItem()` triggers `actionController.reEvaluateEntityCapabilities()`, which calls `ComponentCapabilityController._scanEquippedItemsForActions()`. The method converts item traits to a stats-like format, checks them against all action requirements, and adds capability entries with `_isEquippedItem: true` metadata.

**Example**: The knife item has `Physical.sharpness: 50`. The `cut` action requires `Physical.sharpness >= 20`. Since the knife satisfies this, the `cut` action appears in the action panel with the knife listed as a capable source.

### Effective Stats Resolution

When evaluating action requirements for a component that hosts an equipped item, the capability controller uses the **equipped item's current stats** (not the host component's stats) if the item's traits satisfy the action requirements. This ensures:

- A knife with `sharpness: 50` enables the `cut` action even if the host component has no `sharpness` trait
- Sharpness drain from the `cut` action affects the knife's tracked stats, not the host component
- Capability scoring reflects the **current** sharpness value (e.g., -949 after drain), not the base value (50)

The effective stats resolution follows this priority:

1. **Equipped item stats** — If the component hosts an equipped item whose traits satisfy the action requirements, those stats are used
2. **Host component stats** — If the equipped item lacks relevant traits, fall back to the host component's stats
3. **Host-only evaluation** — Actions evaluated without any equipped item use only host component stats (separate code path)

This decoupling ensures that equipping a knife does not suppress the host component's existing capabilities (e.g., `punch` via `Physical.strength`).

## Mutating Item Stats

When consequences modify item stats (e.g., `cut` drains sharpness via `-999`), the stat consequence handler routes the update to `EquippedItemStatsController.updateStatDelta()`. This is detected via `hasStats(targetId)` — if the target ID matches an equipped item, the routed method is used instead of modifying the host component.

After the stat change, the equipped item stats controller fires a callback that triggers capability re-evaluation. The capability cache then rescans equipped items using **current** (drained) stats instead of base stats, ensuring the UI reflects the actual capability state.

## Equip Flow

When a client clicks "Equip" on an item with a holding cost, the server checks requirements against component stats. If all pass, debuffs are applied and the capability controller re-evaluates, making equipped item actions appear in the UI. If any fail, equip is denied with an error message.

## Drag-and-Drop Auto-Unequip

When an equipped item is dragged to another component via inventory drag-and-drop, the system auto-unequips from both source and target components before moving. This ensures the item is never physically moved while still tracked as equipped, preventing state inconsistency.

## Hand Swap (Transfer)

Moving an equipped item from one component to another involves unequipping from the old component, equipping on the new component with requirement checks, and rolling back if the new component fails requirements.

## Client Integration

The inventory UI shows Equip/Unequip buttons on items with holding costs. The button style changes based on equip status (cyan for equip, orange for unequip).

The action panel (`NavActionsPanel`) shows equipped items with:

- 🔪 knife icon prefix
- Orange left border
- `data-equipped-type` attribute

## Capability Entry Format

Equipped item capability entries contain the entity ID, a resolved component ID, component type/metadata, capability score, and resolution flags (_isEquippedItem, _equippedItemId, _equippedItemType, _equippedComponentId).

## Related Files

- `data/holdingCost.json` — Data definitions
- `data/inventoryItems.json` — Item traits (source for action discovery and base stats)
- `src/controllers/core/HoldingCostController.js` — Core controller (equip/unequip, passes equippedItemStats)
- `src/controllers/core/EquippedItemStatsController.js` — Per-instance mutable stat storage
- `src/controllers/capabilities/componentCapabilityController.js` — `_scanEquippedItemsForActions()` with effective stats
- `src/controllers/consequences/StatConsequenceHandler.js` — Routes stat modifications to equipped items
- `src/routes/inventoryRoutes.js` — API endpoints
- `public/js/InventoryManager.js` — Inventory UI
- `public/js/NavActionsPanel.js` — Action panel with equipped item display
- `public/css/actions.css` — Equipped item row styling