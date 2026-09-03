# BUG-073: Missing Inventory System — Volume-Based Item Storage

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `src/utils/InventoryManager.js`, `src/routes/inventoryRoutes.js`, `public/js/InventoryManager.js`, `public/css/inventory.css`, `data/inventoryItems.json`

## Symptoms

- No way for entities to carry or store items
- No UI to view inventory
- No volume-based capacity management
- No drag-and-drop between components

## Root Cause

The inventory system was not implemented. While components had `Physical.volume` properties, there was no mechanism to track items within those volumes or provide a user interface for inventory management.

## Fix

Implemented a complete inventory system: volume-based item storage on components, a data file defining item types, and a UI overlay (opened from the config bar) that shows components as containers with their items inside and allows moving items between components by drag-and-drop. Why this design:

- **Volume-based capacity** — components already model `Physical.volume`, so item storage reuses that physical property instead of inventing a separate capacity concept.
- **Server-authoritative state** — the server validates every move against volume limits, so a client can never bypass capacity by talking to the API directly.
- **Hierarchical container display** — items live *inside* components, so the UI mirrors that structure (container → items) rather than a flat list.

## Prevention

- Establish feature gap reviews during sprint planning
- Document required systems early in project lifecycle
- Consider user-facing features alongside backend systems

## References
- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related controller: `InventoryManager`, `WorldStateController` (inventory methods)
- Related controller: `ConfigBarManager`, `ComponentViewer`