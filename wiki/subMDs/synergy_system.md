# Synergy System

## Overview

The synergy system computes combined effect multipliers when multiple components collaborate on a single action. When multiple components of the same type are selected, the synergy multiplier is applied to the action's consequence values.

## How It Works

```
Client selects 2+ components → Server computes synergy → Multiplier applied to consequences
```

### Synergy Configuration

Synergy configs are defined in `data/synergy.json` (separate from actions.json for decoupling):

```json
{
  "move": {
    "enabled": true,
    "multiEntity": false,
    "scaling": "diminishingReturns",
    "caps": {},
    "componentGroups": [
      {
        "groupType": "movementComponents",
        "minCount": 1,
        "baseMultiplier": 1.0,
        "perUnitBonus": 0.3,
        "roleFilter": "source"
      }
    ]
  },
  "droid punch": {
    "enabled": true,
    "multiEntity": false,
    "scaling": "diminishingReturns",
    "caps": {
      "damage": { "max": 1.1, "req": "Physical.stability" }
    },
    "componentGroups": [
      {
        "groupType": "sameComponentType",
        "componentType": "droidHand",
        "minCount": 2,
        "baseMultiplier": 1.0,
        "perUnitBonus": 0.05,
        "roleFilter": "source"
      }
    ]
  }
}
```

## Synergy Application

### Backend Application

Synergy multipliers are applied in `ActionController._executeConsequences()` and `ActionController._executeMultiAttackerConsequences()`.

**Critical:** The synergy multiplier is applied to **ALL numeric consequence properties**, not just `value`. This ensures synergy works for:
- `speed` (deltaSpatial - move/dash distance)
- `value` (damageComponent, updateComponentStatDelta)
- Any other numeric parameter added to consequences

```javascript
// Applied to ALL numeric properties in resolvedParams
if (synergyResult && synergyResult.synergyMultiplier > 1.0 && typeof resolvedParams === 'object' && resolvedParams !== null) {
    for (const [key, val] of Object.entries(resolvedParams)) {
        if (typeof val === 'number') {
            resolvedParams[key] = synergyController
                ? synergyController.applySynergyToResult(synergyResult, val)
                : val;
        }
    }
}
```

### Multi-Attacker Punch

For `droid punch` actions with multiple attacker components, each attacker deals its own separate damage:

```javascript
// Triggered when: actionName === 'droid punch' && attackerComponentIds.length > 1 && params.targetComponentId
_executeMultiAttackerConsequences(actionName, entityId, attackerComponentIds, params, synergyResult)
```

Each attacker component:
1. Reads its own `Physical.strength` value
2. Creates a separate `damageComponent` consequence with `-strength` as damage
3. Applies synergy multiplier to each damage value
4. Executes the consequence against the target component

**Example:** 4 components with strength 25, 25, 10, 10:
- Attacker 1 (droidHand left): 25 damage
- Attacker 2 (droidHand right): 25 damage
- Attacker 3 (centralBall): 10 damage
- Attacker 4 (droidHead): 10 damage
- **Total: 70 damage** (before synergy multiplier)

### Frontend Integration

The frontend sends all selected attacker component IDs for punch actions:

```javascript
// App.js - handlePunchTarget
if (attackerComponentIds.length > 1) {
    const components = attackerComponentIds.map(compId => ({
        componentId: compId,
        role: 'source'
    }));
    await this.actions.executeMultiPunch(actionName, entityId, components, targetCompId);
}
```

```javascript
// ActionManager.js - executeMultiPunch
async executeMultiPunch(actionName, entityId, attackerComponents, targetComponentId) {
    const result = await this._sendActionRequest({
        actionName,
        entityId,
        params: {
            componentIds: attackerComponents,
            targetComponentId
        }
    }, 'PUNCH_FAILED');
    return result;
}
```

## Synergy Scaling Curves

Defined in `src/utils/SynergyScaling.js`:

| Curve | Formula | Description |
|-------|---------|-------------|
| `linear` | `base + (count-1) * bonus` | Straight line increase |
| `diminishingReturns` | `base * (1 + bonus * (1 - 1/count))` | Each additional component adds less |
| `increasingReturns` | `base * (1 + bonus * count^0.5)` | Each additional component adds more |

## Known Actions with Synergy

| Action | Synergy Type | Effect |
|--------|-------------|--------|
| `move` | Movement components | `speed * multiplier` → increased move distance |
| `dash` | droidRollingBall (2+) + Movement (2+) | `speed * multiplier` → increased dash distance (requires 2+ of each group) |
| `droid punch` | droidHand (2+) | Each hand deals `strength * multiplier` damage |
| `selfHeal` | Physical components | `value * multiplier` → increased healing (capped at 50) |

## Bug Fixes

### Fix 1: Synergy Not Applied to Non-Value Properties (2026-04-26)

**Problem:** Synergy multiplier was only applied to `resolvedParams.value`, but `move` uses `speed` as its parameter name. This caused synergy to be silently ignored for spatial actions.

**Solution:** Modified `_executeConsequences()` to iterate over ALL numeric properties in `resolvedParams` and apply the synergy multiplier to each one.

### Fix 2: Multi-Attacker Punch Only Used Last Component (2026-04-26)

**Problem:** When 4 components were selected for punch, only the last component's strength value was used for damage. Expected: each component deals its own damage (25+25+10+10=70). Actual: only 10 damage.

**Solution:** 
1. Added `_executeMultiAttackerConsequences()` method that iterates over all attacker components
2. Each attacker deals separate damage based on its own `Physical.strength`
3. Frontend updated to send all attacker component IDs via `executeMultiPunch()`

### Fix 3: Source Component Resolution Returns Target Instead of Attacker (2026-04-26)

**Problem:** For multi-component punch actions with `componentIds` + `targetComponentId`, `_resolveSourceComponent()` Priority 2 returned `targetComponentId` (the enemy's component) instead of an attacker component. This caused binding validation to fail with "Source component not found on entity".

**Solution:** Added Priority 1.5 in `_resolveSourceComponent()` that checks for `componentIds` + `targetComponentId` combination and uses `componentIds[0]` as the source instead of the target.

### Fix 4: Synergy Role Filter Blocks Physical Components for Punch (2026-04-26)

**Problem:** The `_matchesRoleFilter()` method for `'source'` role only allowed components with `Movement` traits. Punch attackers have `Physical` traits, so they were filtered out. Logs showed: `Group "sameComponentType" for droid punch has 0/2 provided members — skipped`.

**Solution:** Modified `_matchesRoleFilter()` to allow both `Movement` AND `Physical` traits for the `'source'` role:
- `Movement` = movement-based actions (move, dash)
- `Physical` = attack-based actions (punch) where strength provides power

### Fix 5: CRITICAL Error — `error.message` Access on Undefined (2026-04-26)

**Problem:** The catch block in `_executeMultiAttackerConsequences` accessed `error.message` without null checking, causing `Cannot read properties of undefined (reading 'message')` when an unexpected error occurred.

**Solution:** Added defensive null check before accessing `error.message`:
```javascript
const errorMsg = error?.message ?? String(error) ?? 'Unknown error';
```

### Fix 6: `_gatherSameComponentType()` Also Blocks Punch Components (2026-04-26)

**Problem:** The `_matchesRoleFilter()` method was fixed in Fix 4 to allow both `Movement` AND `Physical` traits for the `'source'` role. However, `_gatherSameComponentType()` (used for "sameComponentType" synergy groups like droid punch) was NOT updated. It still only checked for `Movement` traits, filtering out all droidHand components that have `Physical` traits.

**Impact:** For 'droid punch' with `groupType: "sameComponentType"` and `roleFilter: "source"`, the synergy group had 0 members → synergy skipped.

**Solution:** Updated `_gatherSameComponentType()` to also allow `Physical` traits for `source`/`spatial` role:
```javascript
if (roleFilter === 'source' || roleFilter === 'spatial') {
    return (stats.Movement && Object.keys(stats.Movement).length > 0) ||
           (stats.Physical && Object.keys(stats.Physical).length > 0);
}
```

### Fix 7: Main `executeAction` Catch Block Also Accesses `error.message` on Undefined (2026-04-27)

**Problem:** Fix 5 only patched the catch block inside `_executeMultiAttackerConsequences`, but the outer `executeAction` try-catch block had the same vulnerability. When an unexpected error occurred, the outer catch block tried to access `error.message` on an undefined value, causing the CRITICAL error: "Cannot read properties of undefined (reading 'message')".

**Impact:** Multi-attacker punch with 4 components crashed with CRITICAL error even though synergy was computed successfully.

**Solution:** Applied the same defensive null check to the main `executeAction` catch block:
```javascript
const errorMsg = error?.message ?? String(error) ?? 'Unknown error';
```

### Fix 8: `_executeConsequences` Catch Block Also Accesses `error.message` on Undefined (2026-04-27)

**Problem:** The catch block inside `_executeConsequences` (used for single-attacker actions like `move`) also accessed `error.message` without null checking.

**Impact:** If any consequence handler threw an unexpected error, the `_executeConsequences` catch block would crash with the same "Cannot read properties of undefined (reading 'message')" error.

**Solution:** Applied the same defensive null check to the `_executeConsequences` catch block:
```javascript
const errorMsg = error?.message ?? String(error) ?? 'Unknown error';
```

### Fix 9: Duplicate Contributing Components in Synergy Result (2026-04-29)

**Problem:** When the `dash` synergy config has two groups (`sameComponentType` + `movementComponents`), both groups matched the same components, creating 4 entries in `contributingComponents` instead of 2. This caused the synergy preview to show duplicate components.

**Impact:** The synergy preview displayed 4 `droidRollingBall` entries when only 2 physical balls existed.

**Solution:** Added deduplication in both `SynergyController._evaluateProvidedComponents()` and `SynergyController._evaluateComponentGroups()` by filtering on `componentId`:
```javascript
// Deduplicate: each component should appear at most once
const seen = new Set();
const unique = [];
for (const c of contributingComponents) {
    if (!seen.has(c.componentId)) {
        seen.add(c.componentId);
        unique.push(c);
    }
}
return { multiplier: totalMultiplier, components: unique };
```

### Fix 10: Dash with 1 Component Moves 4x and Falsely Triggers 2-Component Synergy (2026-05-04)

**Problem:** The `SynergyComponentGatherer` methods (`gatherMovementComponents`, `gatherSameComponentType`) gathered **ALL matching components on the entity**, not just the source component that was selected. For spatial actions, component selection validation is skipped (so no components are locked), meaning ALL Movement components on the entity contribute to synergy even when only 1 was selected.

**Impact:** With an entity that has 2 `droidRollingBall` components (move=10):
- Expected dash speed: 10 × 2 × 1.0 = **20** (1 component, no synergy)
- Actual dash speed: 10 × 2 × 1.95 = **39** (synergy incorrectly computed as 1.3 × 1.5)

**Solution (3 parts):**

1. **`SynergyComponentGatherer.js`**: All gather methods now accept a `sourceComponentId` parameter. When provided, only include the source component (plus same-type siblings for `sameComponentType` groups).

2. **`synergyController.js`**: Updated `_gatherGroupMembers()` to pass `sourceComponentId` as the 5th parameter to all gatherer methods.

3. **`data/synergy.json`**: Changed `movementComponents` group's `minCount` from `1` to `2` for dash (synergy only triggers when 2+ movement sources are actively involved).

**Expected behavior after fix:**
- 1 droidRollingBall: synergy = 1.0x → speed = 20
- 2 droidRollingBalls: synergy = 1.5 × 1.3 = 1.95x → speed = 39
