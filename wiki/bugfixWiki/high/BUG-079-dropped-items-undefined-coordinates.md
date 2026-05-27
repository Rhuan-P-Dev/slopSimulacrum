# BUG-079: Dropped Items Appear at (undefined, undefined) — Invisible on Map

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `data/actions.json` (lines 169-174)

## Symptoms

When a player drops an item (e.g., knife), the console log shows:
```
ℹ️ INFO: [2026-05-27T14:38:50.376Z] [INFO] [DropItemHandler] Dropped item "knife" (item-14) at (undefined, undefined).
```

Dropped items are stored with `x: undefined, y: undefined`, making them invisible on the world map. Blue square markers render at NaN positions and cannot be clicked.

## Root Cause

The `dropItem` consequence in `data/actions.json` was missing `targetX` and `targetY` placeholders in its params.

### Data Flow Trace

1. **Client** → `ActionManager.executeDropItem()` sends `{ params: { itemId, itemType, targetX, targetY } }`
2. **Server** → `actionRoutes.js` passes `params` directly to `worldStateController.executeAction()`
3. **ActionController** → forwards `params` to `ConsequenceDispatcher.execute()`
4. **ConsequenceDispatcher** → builds `resolutionContext = { ...actionParams, ...requirementValues }` which **does** contain `targetX` and `targetY`
5. **PlaceholderResolver** → iterates over the keys of the consequence params object (`entityId`, `itemId`, `itemType`). **`targetX` and `targetY` are never resolved because they don't exist as keys in the consequence params.**
6. **DropItemHandler** → line 38 destructures `{ entityId, itemId, itemType, targetX, targetY }` from resolved params → **both are `undefined`**

The `resolvePlaceholders` function only resolves existing keys from its input object — it does **not** add new keys from the resolution context. Since the consequence params only defined 3 keys (`entityId`, `itemId`, `itemType`), `targetX` and `targetY` were never present in the resolved params passed to the handler.

```json
// BEFORE (broken - missing targetX/targetY):
{
  "type": "dropItem",
  "target": "target",
  "params": { "entityId": ":entityId", "itemId": ":itemId", "itemType": ":itemType" }
}
```

## Fix

Add `targetX` and `targetY` placeholders to the `dropItem` consequence params in `data/actions.json`:

```json
// AFTER (fixed):
{
  "type": "dropItem",
  "target": "target",
  "params": {
    "entityId": ":entityId",
    "itemId": ":itemId",
    "itemType": ":itemType",
    "targetX": ":targetX",
    "targetY": ":targetY"
  }
}
```

The `resolvePlaceholders` function will now resolve `:targetX` and `:targetY` from `resolutionContext` (which already contains them from the client's action params), producing the correct numeric values that `DropItemHandler` expects.

## Prevention

- When adding spatial targeting to actions, ensure consequence params include `:targetX` and `:targetY` placeholders.
- Review data-driven consequence definitions against handler expectations: the handler's destructured params must match the resolved consequence params.
- Use schema validation for action definitions to verify all required placeholders are present for each consequence type.

## References
- Related wiki: `wiki/subMDs/systems/world_map_pickup.md`
- Related controller: `DropItemHandler`, `ConsequenceDispatcher`, `ActionController`