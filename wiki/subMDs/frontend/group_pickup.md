# Group Pick (Cluster Pickup)

## Problem

Dropped items form piles. A broken furniture component drops several
`chunk_<material>` items; a damaged generator sheds parts; anything looted in
a scuffle lands next to whatever was already on the floor. The pickup flow
was strictly one item per click — hover, click, component selector, execute —
so clearing a 6-item pile meant running that ceremony six times, one by one.

## Solution

Clicking any dropped-item marker that sits in a **cluster** (>= `minItems`
items within the data-driven cluster `radius`) opens the **Group Pick window**
instead of the single-item overlay. The window is a floor-inventory view:

- **Stacks by type** — one row per `itemType` (chunks stack with chunks, T1s
  with T1s), in first-appearance order;
- **Quantity stepper per row** — pick how many of that type; quantities
  default to "all in-range" (opening the window already expresses the intent
  to clear the pile; the steppers dial back);
- **Search filter** — narrows the list by name or type, for big mixed piles;
- **Honest range display** — instances beyond the droid's pickup range are
  shown dimmed with an "out of range" badge but are **not selectable**; the
  server remains the authority and would reject each of them;
- **One Execute** — routes through the *existing* pickup pipeline: the shared
  component selector (one receiving component, the player's choice, exactly
  like a single pickup) and then `POST /pick-up-item` per item, **sequentially
  on the same component**, with a single world-state refresh at the end.

Single-item clicks (sparse floor, fewer than `minItems` nearby) are
unchanged — the historical overlay flow still runs.

## Why data-driven (and which layer owns what)

The cluster `radius` and trigger `minItems` live in
`data/actions.json` under `pickUpItem.groupPick` — the same file that owns
the pickup range and requirements. The capability projection
(`GET /actions` / per-entity actions) spreads raw action data, so the
sub-object reaches the client intact; `AppConfig.GROUP_PICK` is only the
missing-data fallback (the same fallback pattern the pickup-range circle
already uses). Tuning the feature is a data-only change.

The LLM context projection is deliberately unaffected: it picks known fields
only (`name`, `description`, `range`, `canExecute`, `requirement`), so the
UI config never leaks into model context.

**Server authority is unchanged.** There is no batch endpoint and no server
code change: each chosen instance passes the identical `pickUpItem` pipeline
(independently re-checked range, remaining component volume, trait
requirements). A batch larger than the selected component degrades to a
best-effort partial success — items are picked in order until the capacity
error; the failures surface on the window's status line (or as a standard
error when the floor is now sparse), and the window re-opens with the
remaining cluster, rebuilt from the refreshed world state. Nothing is
silently lost, and nothing bypasses a check.

## Client flow

```
marker click
  → _checkPickUpRange (out of range → error, as before)
  → _buildGroupPickCluster (radius from pickUpItem.groupPick)
      → >= minItems → GroupPickOverlay.show (annotated: inRange per item)
      → <  minItems → single-item overlay (unchanged)
  → "Pick Up" in window → pending batch stored
  → DropSelector (pickup mode, one component) → Execute
  → ActionExecutor.executePickUpBatch (per-item POST /pick-up-item, sequential)
  → world refresh → window re-opens with the remaining cluster (if any)
```

## Files

- `data/actions.json` — `pickUpItem.groupPick` (`radius`, `minItems`).
- `public/utils/GroupPick.js` — pure decision core: `resolveGroupPickConfig`
  (data-driven config + fallback), `clusterAround` (cluster detection),
  `groupIntoStacks` (per-type stacks with the in/out-of-range split and
  volume sums), `matchesFilter` (search), `expandSelection` (quantity →
  first-N in-range instances), `selectionVolume`.
- `public/js/GroupPickOverlayController.js` — the floating window (thin DOM
  shell over the pure utils; OverlayManager-registered, no config-bar
  button, no keyboard shortcut — opened programmatically by the cluster
  click).
- `public/js/App.js` — orchestrator: cluster detection on marker click,
  pending-batch state, the `_onPickUpSelectorExecute` group branch.
- `public/js/ActionExecutor.js` — `executePickUpBatch` (per-item requests,
  batch-level side effects: one range-indicator reset, one selection clear,
  one world refresh).
- `public/js/Config.js` — `AppConfig.GROUP_PICK` fallback constants.
- `public/css/floating-windows.css` — window styling.

## Tests

- `test/unit/GroupPick.utils.test.js` — the pure decision core (cluster
  math, stacking, filter, expansion clamping, config fallback).
- `test/contract/groupPick.contract.test.js` — the data path on the real
  world: `data/actions.json` validity, and the `groupPick` sub-object
  surviving both capability projections (shared and entity-scoped).
