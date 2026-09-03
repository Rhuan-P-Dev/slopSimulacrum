# BUG-079: Dropped Items Appear at (undefined, undefined) — Invisible on Map

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `data/actions.json` (lines 169-174)

## Symptoms

When a player drops an item (e.g., knife), the log shows `INFO: [DropItemHandler] Dropped item "knife" (item-14) at (undefined, undefined).` Dropped items are stored with `x: undefined, y: undefined`, making them invisible on the world map. Blue square markers render at NaN positions and cannot be clicked.

## Root Cause

The `dropItem` consequence in `data/actions.json` was missing `targetX` and `targetY` placeholders in its params. The coordinates were already available by the time the consequence executed — the client sends them in the action params and they are present in the dispatcher's resolution context — but the placeholder resolver only resolves keys that already exist in the consequence params definition; it does **not** add new keys from the context. Since the consequence only defined 3 keys (`entityId`, `itemId`, `itemType`), the coordinates were never present in the resolved params the handler destructured, so both came out `undefined`.

## Fix

Added `:targetX` and `:targetY` placeholders to the `dropItem` consequence params in `data/actions.json`. Why: the data-driven consequence definition is the only place where action params can be mapped to handler params, so any value the handler destructures must be declared as a placeholder there — with the placeholders present, the resolver picks the coordinates up from the resolution context and the handler receives real numbers.

## Prevention

- When adding spatial targeting to actions, ensure consequence params include `:targetX` and `:targetY` placeholders.
- Review data-driven consequence definitions against handler expectations: the handler's destructured params must match the resolved consequence params.
- Use schema validation for action definitions to verify all required placeholders are present for each consequence type.

## References
- Related wiki: `wiki/subMDs/systems/world_map_pickup.md`
- Related controller: `DropItemHandler`, `ConsequenceDispatcher`, `ActionController`