# BUG-110: Knife Cut Action — No Damage Dealt and No Sharpness Drain

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `actionController.js`, `ConsequenceDispatcher.js`, `StatConsequenceHandler.js`

## Symptoms

When the player attacks with a knife using the "cut" action:
1. The action reports "executed successfully" in logs
2. No damage is dealt to the target component
3. The knife's sharpness stat does not decrease (no -1 drain)
4. The knife should lose -1 sharpness per use per the action definition

## Root Cause

Two interconnected bugs in the consequence handling pipeline for equipped item actions:

### Bug #1: `resolvedSourceComponentId` Overwritten to Host Component ID

In `actionController.js`, when an equipped item (eqId) was resolved as the source component, the code **overwrote** the eqId with the host component ID:

```javascript
// OLD CODE — BUG
resolvedSourceComponentId = foundEquipped.componentId;  // Loses eqId reference!
```

This meant consequence handlers received the host component ID (`comp-...`) instead of the equipped item ID (`eq-...`), preventing them from routing stat changes to `EquippedItemStatsController`.

### Bug #2: `fulfillingComponents` Map Lost eqId Reference

The `fulfillingComponents` map stored the host component ID as the fulfilling component for sharpness requirements. When `ConsequenceDispatcher._resolveTargetForConsequence` resolved the 'self' target, it returned the host component ID instead of the eqId.

### Bug #3: `StatConsequenceHandler` Couldn't Route to EquippedItemStatsController

`StatConsequenceHandler._handleUpdateComponentStatDelta()` checked `hasStats(targetId)` — but since `targetId` was the host component ID (`comp-...`) and not the eqId (`eq-...`), it failed to route to `EquippedItemStatsController` and instead tried to update the host component's `Physical.sharpness` stat (which doesn't exist).

## Fix

### 1. `actionController.js` — Preserve eqId, Store hostComponentId Separately

```javascript
// NEW CODE — Fixed
let resolvedSourceComponentId = this.componentResolver.resolveSourceComponent(action, entityId, params, requirementCheckResult);
let hostComponentId = null;

if (resolvedSourceComponentId && IdResolver.isEquippedId(resolvedSourceComponentId)) {
    // ... find equipped item ...
    hostComponentId = foundEquipped.componentId;
    // DO NOT overwrite resolvedSourceComponentId — the eqId is preserved for consequence routing
}

// For equipped item actions, pass hostComponentId in params for debugging
if (resolvedSourceComponentId && IdResolver.isEquippedId(resolvedSourceComponentId) && hostComponentId) {
    params.hostComponentId = hostComponentId;
}
```

### 2. `ConsequenceDispatcher.js` — Pass eqId in Context for 'self' Targets

```javascript
const isEquippedItemSelf = consequence.target === 'self' && 
    context.actionParams.attackerComponentId && 
    IdResolver.isEquippedId(context.actionParams.attackerComponentId);

const handlerContext = {
    ...context,
    actionParams: { ...context.actionParams, consequenceTarget: consequence.target },
    ...(isEquippedItemSelf ? { resolvedSourceId: context.actionParams.attackerComponentId } : {})
};
```

### 3. `StatConsequenceHandler.js` — Route to EquippedItemStatsController via resolvedSourceId

```javascript
// For equipped item 'self' targets on host components, try the resolvedSourceId
const resolvedSourceId = context?.resolvedSourceId;
if (resolvedSourceId && this.equippedItemStats?.hasStats(resolvedSourceId)) {
    const success = this.equippedItemStats.updateStatDelta(resolvedSourceId, trait, stat, value);
    return { /* ... */ };
}
```

## Prevention

1. **Never overwrite typed eqIds** — When an action source is an equipped item, the eqId must be preserved through the entire execution pipeline
2. **Consequence handlers must check for `resolvedSourceId`** — When handling 'self' targets on equipped item actions, the context should include the eqId for proper routing
3. **Use `IdResolver` for ID type checking** — Always use `IdResolver.isEquippedId()`, `IdResolver.isCompId()` instead of string prefix checks

## References

- Related wiki: `wiki/subMDs/data/holding_cost.md`
- Related wiki: `wiki/subMDs/systems/sharpness_system.md`
- Related controller: `EquippedItemStatsController`
- Related controller: `HoldingCostController`
- Related controller: `RequirementResolver`