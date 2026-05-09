# BUG-050: Consequences Missing Explicit Target Field

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/ConsequenceDispatcher.js`, `data/actions.json`, `src/controllers/DamageConsequenceHandler.js`, `src/controllers/StatConsequenceHandler.js`, `src/controllers/EquipmentConsequenceHandler.js`, `src/controllers/SpatialConsequenceHandler.js`, `src/controllers/LogConsequenceHandler.js`, `src/controllers/EventConsequenceHandler.js`

## Symptoms

Consequences and failureConsequences in `data/actions.json` had no explicit `target` field. Target resolution was implicit and handled differently by each handler:

- `ConsequenceDispatcher._resolveTarget()` used consequence type to guess the target
- `DamageConsequenceHandler` read `context.actionParams.targetComponentId` directly
- `StatConsequenceHandler` used a 3-priority fallback chain
- `SpatialConsequenceHandler` always used `entityId`
- Handlers had inconsistent behavior for `self` vs `target` vs entity-wide operations

This led to:
1. **Implicit behavior**: No clear documentation of who each consequence affects
2. **Inconsistent resolution**: Each handler resolved targets differently
3. **Hard to extend**: Adding new target types required changes in multiple places
4. **No validation**: Missing target info was never validated

## Root Cause

The original consequence system was designed with implicit target resolution:
- Spatial consequences always targeted the entity
- Other consequences used `targetComponentId` from params or fell back to `entityId`
- No standard way to express "this consequence affects the source component" vs "this consequence affects the enemy target"

## Fix

### 1. Added Mandatory `target` Field to All Consequences

Every consequence and failureConsequence in `data/actions.json` now MUST include a `target` field:

| Target | Meaning | Resolves To |
|--------|---------|-------------|
| `"self"` | The source component fulfilling the requirement | Source component ID from `fulfillingComponents` |
| `"target"` | The explicitly targeted entity/component | `params.targetComponentId` or `params.targetEntityId` |
| `"entity"` | The entire entity performing the action | `entityId` |

### 2. Added `_resolveTargetForConsequence()` Method

`ConsequenceDispatcher._resolveTargetForConsequence()` replaces the old `_resolveTarget()` method:

```javascript
_resolveTargetForConsequence(consequence, entityId, params, fulfillingComponents, action) {
    // MANDATORY: target field must be specified
    if (!consequence.target) {
        Logger.error(`[ConsequenceDispatcher] Consequence type "${consequence.type}" in action "${actionName}" ` +
            `is missing required 'target' field. Expected: 'self', 'target', or 'entity'.`);
        return { success: false, error: 'Missing target field' };
    }

    switch (consequence.target) {
        case 'self': {
            const selfKey = Object.keys(fulfillingComponents).find(k => fulfillingComponents[k]);
            return { success: true, targetId: fulfillingComponents[selfKey] || entityId };
        }
        case 'target':
            return { success: true, targetId: params.targetComponentId || params.targetEntityId || entityId };
        case 'entity':
            return { success: true, targetId: entityId };
        default:
            Logger.error(`Unknown target type "${consequence.target}"...`);
            return { success: false, error: `Unknown target type: ${consequence.target}` };
    }
}
```

### 3. Updated All Consequence Handlers

Each handler now receives a pre-resolved `targetId` and can interpret it based on the `consequenceTarget` in context:

| Handler | `'self'` Behavior | `'target'` Behavior | `'entity'` Behavior |
|---------|-------------------|---------------------|---------------------|
| `damageComponent` | Damage source component | Damage target component | Damage ALL entity components |
| `updateComponentStatDelta` | Update source component | Update target component | Update ALL entity components |
| `deltaSpatial` | Move source entity | Move target entity | Move entity |
| `log` | Log with source context | Log with target context | Log with entity context |

### 4. Removed `componentBinding` from Actions

The `componentBinding` metadata was removed from `data/actions.json` as it was redundant — the `target` field on consequences provides the same information more explicitly.

### 5. Updated `data/actions.json`

All 9 actions updated with explicit `target` fields:

| Action | Consequence | New `target` |
|--------|------------|----------|
| `move` | `deltaSpatial` | `entity` |
| `dash` | `deltaSpatial` | `entity` |
| `dash` | `updateComponentStatDelta` (durability) | `self` |
| `selfHeal` | `updateComponentStatDelta` (durability) | `self` |
| `droid punch` | `damageComponent` | `target` |
| `droid punch` | `log` | `self` |
| `grab` | `grabItem` | `target` |
| `grab` | `log` | `self` |
| `cut` | `damageComponent` | `target` |
| `cut` | `updateComponentStatDelta` (sharpness) | `self` |
| `dropAll` | `dropAll` | `entity` |
| All | `failureConsequences` | Per-action definition |

## Prevention

1. **Mandatory `target` field**: The `ConsequenceDispatcher` validates that every consequence has a `target` field. If missing, it logs an error and skips the consequence.
2. **Wiki documentation**: Updated `wiki/subMDs/action_system.md` and `wiki/subMDs/consequence_handler_architecture.md` with target field documentation.
3. **Action templates**: New actions should follow the documented pattern with explicit `target` fields.

## References

- Related wiki: `wiki/subMDs/action_system.md`
- Related wiki: `wiki/subMDs/consequence_handler_architecture.md`
- Related controller: `ConsequenceDispatcher`
- Related controller: `ActionController`