# BUG-076: Dropped Items Not Persisted Across Server Restarts

- **Severity**: HIGH
- **Status**: 🔴 Open
- **Fixed In**: —
- **Related Files**: `src/controllers/WorldStateController.js`, `src/routes/inventoryRoutes.js`

## Symptoms

Dropped items stored in `worldStateController._droppedItems` are lost when the server restarts because they are only held in memory. Items dropped in the world disappear on restart.

## Root Cause

The dropped items system uses an in-memory object (`this._droppedItems`) rather than persisting to a data file. This follows the pattern of other transient state but means dropped items don't survive server restarts.

## Fix

Options:
1. **Persist to JSON file** — Load from `data/droppedItems.json` on startup, save on each change
2. **Accept ephemeral behavior** — Document that dropped items are temporary session-only

## Prevention

When implementing new state-holding systems, decide early whether persistence is required and use `DataLoader.loadJsonSafe()` + `fs.writeFileSync()` accordingly.

## References
- Related wiki: `wiki/subMDs/systems/item_drop_pickup.md`
- Related controller: `WorldStateController`