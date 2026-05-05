# BUG-048: Dash with 1 Component Moves 4x and Falsely Triggers 2-Component Synergy

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**:
  - `src/controllers/SynergyComponentGatherer.js` (lines 25-108, 110-150, 152-194, 196-250)
  - `src/controllers/synergyController.js` (lines 270-287)
  - `data/synergy.json` (lines 35-43)
  - `src/controllers/ConsequenceDispatcher.js` (lines 215-227)

## Symptoms

- When dash is executed with 1 Movement component, the entity moves 4x the base speed instead of 2x
- The 2-component synergy falsely triggers even with only 1 component selected
- The expected speed for dash is: `baseMove × 2 × synergyMultiplier`
- With 1 component (move=10): expected = 10 × 2 × 1.0 = **20**, actual = 10 × 2 × 1.95 = **39**

## Root Cause

The `SynergyComponentGatherer` methods (`gatherMovementComponents`, `gatherSameComponentType`) gathered **ALL matching components on the entity**, not just the source component that was selected.

For spatial actions, component selection validation is skipped (`actionController.js` line 253), so no components are locked. This means **ALL Movement components on the entity contribute to synergy** even when only 1 was selected by the user.

Additionally, the `movementComponents` synergy group had `minCount: 1`, which meant synergy was **always active** for dash (even with 1 component), amplifying the incorrect gathering.

### Data Flow Example

With an entity that has 2 `droidRollingBall` components (both with `Movement.move = 10`):

1. User clicks 1 component to dash
2. `sourceComponentId` is set to the clicked component
3. **OLD**: `gatherMovementComponents` gathers BOTH `droidRollingBall` components (2 members)
4. **OLD**: `gatherSameComponentType` gathers BOTH `droidRollingBall` components (2 members)
5. **OLD**: `movementComponents` multiplier = 1.0 + (2-1) × 0.3 = **1.3**
6. **OLD**: `sameComponentType` multiplier = 1.0 + (2-1) × 0.5 = **1.5**
7. **OLD**: Total multiplier = 1.3 × 1.5 = **1.95**
8. **OLD**: Final speed = 10 × 2 × 1.95 = **39** (≈4× base)

### Expected Behavior

With 1 component:
1. Only the selected source component is counted
2. `movementComponents` group: 1 member → **minCount: 2 skipped**
3. `sameComponentType` group: 1 member → **minCount: 2 skipped**
4. Total multiplier = **1.0**
5. Final speed = 10 × 2 × 1.0 = **20** (correct)

## Fix

### 1. `SynergyComponentGatherer.js` — Add `sourceComponentId` filtering

All gather methods now accept a `sourceComponentId` parameter. When provided:
- **`gatherSameComponentType`**: Only includes the source component + same-type siblings (not all entity components)
- **`gatherMovementComponents`**: Only includes the source component
- **`gatherAnyPhysicalComponent`**: Only includes the source component
- **`gatherAllComponents`**: Only includes the source component

```javascript
// Example: gatherMovementComponents with sourceComponentId
if (sourceComponentId) {
    const sourceStats = this.worldStateController.componentController.getComponentStats(sourceComponentId);
    if (!sourceStats || !sourceStats.Movement) return [];
    return [{
        componentId: sourceComponentId,
        entityId: entity.id,
        componentType: sourceComponent.type,
        stats: sourceStats
    }];
}
```

### 2. `synergyController.js` — Pass `sourceComponentId` to gatherers

Updated `_gatherGroupMembers` to pass `sourceComponentId` as the 5th parameter to all gatherer methods.

```javascript
case 'movementComponents':
    return this.componentGatherer.gatherMovementComponents(
        entity, groupDef, roleFilter, lockedComponentIds, sourceComponentId
    );
```

### 3. `data/synergy.json` — Change `movementComponents` minCount

Changed `minCount` from `1` to `2` for the `movementComponents` group in the dash synergy config.

```json
{
    "groupType": "movementComponents",
    "minCount": 2,  // Was: 1
    "description": "Multiple Movement components bound as source contribute to dash synergy (both legs working together)."
}
```

## Prevention

1. **Gatherer methods should always respect `sourceComponentId`**: When a source component is explicitly provided (as in spatial actions), gatherers must filter to only that component (plus same-type siblings for `sameComponentType` groups).

2. **Synergy minCount should match the intended behavior**: Groups that require multi-component interaction should have `minCount: 2` or higher.

3. **Test with single-component scenarios**: Always verify synergy computation with exactly 1 component to ensure the multiplier is 1.0.

## References

- Related wiki: `wiki/subMDs/synergy_system.md`
- Related wiki: `wiki/subMDs/controller_patterns.md`
- Related controller: `SynergyComponentGatherer`
- Related controller: `SynergyController`
- Related wiki: `wiki/map.md` (Dash Action Component Resolution section)