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

## Data Model

Holding cost definitions are stored in `data/holdingCost.json`, one entry per equip-able item type. Each entry declares the stat requirements the hosting component must be able to bear. A single value per requirement serves double duty — it is both the minimum the host must have to equip the item and the magnitude of the debuff the host suffers while the item is equipped. Requiring the two to be the same number keeps the burden proportional to the requirement: an item that demands a stronger component penalizes that component harder.

### Constraints

- **All-or-nothing**: every requirement must be satisfiable for equip to succeed, so a host can never carry only part of an item's burden
- **Reversible**: debuffs exist only while the item is equipped and are fully reversed on unequip, so carrying a burden is always temporary and tied to actual possession

## Item Traits and Action Discovery

Equipped items keep their own traits (defined in `data/inventoryItems.json`) independent of component stats. The capability system evaluates equipped items as separate action sources, so an item's traits can unlock actions that the hosting component could never satisfy on its own.

**Example**: A knife carries a `Physical.sharpness` trait. That trait — not the host hand's stats — is what makes the `cut` action appear in the action panel with the knife listed as the capable source, even though the hand has no sharpness of its own.

### Effective Stats Resolution

When an equipped item's traits satisfy an action's requirements, that action is evaluated against the item's own current stats rather than the host's, for two reasons:

- The item must be able to enable actions the host component could never qualify for by itself
- Wear and drain accumulate on the item, so its real-time stats — not its base values — determine whether the action stays available as the item degrades

When an item contributes nothing to an action, the host component's own stats are evaluated on their own. This decoupling ensures that equipping a knife does not suppress the host component's existing capabilities (e.g., `punch` via `Physical.strength`).

## Mutating Item Stats

Stat changes produced by action consequences (e.g., sharpness drain from cutting) are applied to the equipped item's per-instance stats rather than to the host component, so each equipped item tracks its own wear independently. After such a change, capabilities are re-evaluated against the item's current (drained) stats so the UI reflects the item's actual capability state, not its factory values.

## Equip Flow

Equipping is gated on the item's requirements: a component may only equip an item it can physically bear. A successful equip applies the burden debuffs and re-evaluates capabilities, so item-derived actions appear in the UI in lockstep with equipment state; a failed check denies equip with an error instead.

## Drag-and-Drop Auto-Unequip

When an equipped item is dragged to another component via inventory drag-and-drop, the system auto-unequips from both source and target components before moving. This ensures the item is never physically moved while still tracked as equipped, preventing state inconsistency.

## Hand Swap (Transfer)

Moving an equipped item to another component is treated as an unequip plus a fresh re-equip, never as a plain move: the old host's debuffs are lifted, the new host must pass requirement checks, and a failed check rolls the transfer back. This keeps debuffs bound to actual possession and prevents a component from continuing to carry a burden it no longer holds.

## Client Integration

The client surfaces equipment state directly in the inventory UI and the action panel so players can see at a glance which items are equipped, which component bears their burden, and which capabilities those items unlock.

## Capability Entry Metadata

Capability entries derived from equipped items carry metadata identifying the source item and the component that hosts it, so the UI can distinguish item-derived capabilities from component-derived ones and trace any such capability back to the item that provides it.

## Related Files

- `data/holdingCost.json` — Data definitions
- `data/inventoryItems.json` — Item traits (source for action discovery and base stats)
- `src/controllers/core/HoldingCostController.js` — Core controller (equip/unequip, passes equippedItemStats)
- `src/controllers/core/EquippedItemStatsController.js` — Per-instance mutable stat storage
- `src/controllers/capabilities/componentCapabilityController.js` — Equipped-item action scanning with effective stats resolution
- `src/controllers/consequences/StatConsequenceHandler.js` — Routes stat modifications to equipped items
- `src/routes/inventoryRoutes.js` — API endpoints
- `public/js/InventoryManager.js` — Inventory UI
- `public/js/NavActionsPanel.js` — Action panel with equipped item display
- `public/css/actions.css` — Equipped item row styling
