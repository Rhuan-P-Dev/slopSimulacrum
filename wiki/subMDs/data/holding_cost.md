# 📦 Holding Cost System (Mass-Based Burden)

## Purpose

Equipping an item is a physical act. An equipped item is a **small component** — its own matter, its own organs, its own existence — that is **never merged into the host**. The burden of carrying is expressed by a single lever: the **total mass carried** reduces the carrier's effective output of the function stats carrying costs most — `move` and `fine_controls`. Equipping itself is gated on the host being able to bear the item's mass (a strength/mass check), so a component that cannot carry a burden can never start carrying it.

## Design Decisions

### Why one mass lever instead of a hand-tuned debuff list?

The old model stored, per equipable item, a hand-tuned list of per-stat requirements that doubled as debuffs. That is an N×M tuning matrix in disguise: every new item × every affected stat needs a number, and the numbers have no physical cause. A single lever (mass) explains the whole burden: mass is already derived from what an item is made of, so any new item's cost is known without a new tuning entry. A droid stuffed with organs and gear gets slower and clumsier — the physical price of ambition.

### Why `move` and `fine_controls`, and why is `strength` only the gate?

Carrying weight costs autonomy and precision first: how fast the carrier can move and how carefully it can handle things degrade with load — so the burden reduces effective `move` and `fine_controls`. Strength is not the ongoing cost; it is the **gate at equip time** — can the host bear this mass? — which is why the check happens once on equip rather than as a continuous debuff.

### Why NOT merge items into components?

Equipped items are independent action sources, NOT merged into component stats. This preserves clean separation:

- Using a knife degrades the knife, not the hand — the item has its own existence and its own wear
- Component stats represent the component itself
- The capability system scans both entity components AND equipped items independently

### Why data-driven?

Burden definitions live in `data/holdingCost.json`, not hardcoded, so new equipable items do not require controller changes. The file declares how the mass burden applies; the mass itself is derived from the item's matter.

## Data Model

Each entry in `data/holdingCost.json` defines the burden of one equipable item type through mass rather than through a list of per-stat debuffs:

- **Equip gate** — the host must be able to bear the item's mass (a strength/mass check). All-or-nothing: a host can bear the item's mass or it cannot equip — there is no such thing as carrying only part of a burden.
- **Carrying cost** — while equipped, the item's mass joins the carrier's total carried mass, which reduces the carrier's effective `move` and `fine_controls`.
- **Reversible** — the burden exists only while the item is equipped; unequipping fully restores the carrier's effective output, so carrying a burden is always temporary and tied to actual possession.

## Item Stats and Action Discovery

Equipped items keep their own stats — derived from their own matter, and organ-granted where the item carries ICs — independent of the host component's stats. The capability system evaluates equipped items as separate action sources, so an item's stats can unlock actions that the hosting component could never satisfy on its own.

**Example**: A knife carries `sharpness` — a depletable quality of its edge material, not a hand-tuned number. That stat — not the host hand's stats — is what makes the `cut` action appear in the action panel with the knife listed as the capable source, even though the hand has no sharpness of its own.

### Effective Stats Resolution

When an equipped item's stats satisfy an action's requirements, that action is evaluated against the item's own current stats rather than the host's, for two reasons:

- The item must be able to enable actions the host component could never qualify for by itself
- Wear accumulates in the item's own matter, so its current derived stats — not its factory values — determine whether the action stays available as the item degrades

When an item contributes nothing to an action, the host component's own stats are evaluated on their own. This decoupling ensures that equipping a knife does not suppress the host component's existing capabilities (e.g., `punch` via `strength`).

## How Wear Reaches an Item

An item does not lose individual stat values: its **matter depletes through a damage channel**, and its derived stats (and existence) re-derive from the matter that remains. After such a change, capabilities are re-evaluated against the item's current derived stats so the UI reflects the item's actual capability state, not its factory values.

## Equip Flow

Equipping is gated on the host being able to bear the item's mass (a strength/mass check). A successful equip adds the item's mass to the carrier's total carried mass — reducing effective `move` and `fine_controls` — and re-evaluates capabilities, so item-derived actions appear in the UI in lockstep with equipment state; a failed check denies equip with an error instead.

## Drag-and-Drop Auto-Unequip

When an equipped item is dragged to another component via inventory drag-and-drop, the system auto-unequips from both source and target components before moving. This ensures the item is never physically moved while still tracked as equipped, preventing state inconsistency.

## Hand Swap (Transfer)

Moving an equipped item to another component is treated as an unequip plus a fresh re-equip, never as a plain move: the old carrier's burden is lifted (its effective output restored), the new carrier must pass the strength/mass gate, and a failed check rolls the transfer back. This keeps the burden bound to actual possession and prevents a component from continuing to carry a weight it no longer holds.

## Client Integration

The client surfaces equipment state directly in the inventory UI and the action panel so players can see at a glance which items are equipped, which component bears their weight, and which capabilities those items unlock.

## Capability Entry Metadata

Capability entries derived from equipped items carry metadata identifying the source item and the component that hosts it, so the UI can distinguish item-derived capabilities from component-derived ones and trace any such capability back to the item that provides it.

## Related Files

- `data/holdingCost.json` — burden definitions (the single mass lever)
- `data/inventoryItems.json` — item recipes: the item's own matter, form, and organs (source for action discovery)
- `src/controllers/core/HoldingCostController.js` — Core controller (equip/unequip, passes equippedItemStats)
- `src/controllers/core/EquippedItemStatsController.js` — Per-instance stat storage for equipped items
- `src/controllers/capabilities/componentCapabilityController.js` — Equipped-item action scanning with effective stats resolution
- `src/controllers/consequences/StatConsequenceHandler.js` — Routes channel damage to equipped items
- `src/routes/inventoryRoutes.js` — Inventory routes
- `public/js/InventoryManager.js` — Inventory UI
- `public/js/NavActionsPanel.js` — Action panel with equipped item display
- `public/css/actions.css` — Equipped item row styling
