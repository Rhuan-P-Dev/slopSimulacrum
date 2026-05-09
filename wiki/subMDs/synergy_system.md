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
    "scaling": "diminishingReturns",
    "caps": {},
    "componentGroups": [
      {
        "groupType": "sameComponentType",
        "minCount": 1,
        "scaling": "diminishingReturns",
        "baseMultiplier": 1.0,
        "perUnitBonus": 0.3,
        "roleFilter": "source",
        "description": "Multiple movement components on the entity boost speed."
      }
    ]
  },
  "droid punch": {
    "enabled": true,
    "scaling": "diminishingReturns",
    "caps": {
      "damage": { "max": 1.1, "req": "Physical.stability" }
    },
    "componentGroups": [
      {
        "groupType": "sameComponentType",
        "minCount": 2,
        "scaling": "diminishingReturns",
        "baseMultiplier": 1.0,
        "perUnitBonus": 0.05,
        "roleFilter": "source",
        "description": "Multiple droidHand components boost punch damage."
      }
    ]
  }
}
```

**Note:** All `groupType` values use `"sameComponentType"`. The component type is **auto-detected** from the source component at runtime — no `componentType` field is needed in config.

## Synergy Application

### Backend Application

Synergy multipliers are applied in `ConsequenceDispatcher._applySynergy()`, which is called by both `execute()` (single-attacker) and `executeMultiAttacker()` (multi-attacker).

**Note:** Cross-entity synergy (`multiEntity`) has been removed from the codebase. Synergy now only applies to components within a single entity.

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
this.consequenceDispatcher.executeMultiAttacker(actionName, entityId, attackerComponentIds, params, synergyResult)
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
| `move` | sameComponentType (minCount=1) | `speed * multiplier` → increased move distance |
| `dash` | sameComponentType (2+ RollingBall + 2+ Movement) | `speed * multiplier` → increased dash distance |
| `droid punch` | sameComponentType (2+ droidHand) | Each hand deals `strength * multiplier` damage |
| `selfHeal` | sameComponentType (self_target) | `value * multiplier` → increased healing (capped at 50) |

## Synergy Evaluation Paths

There are two code paths for computing synergy:

### Path 1: `_evaluateComponentGroups` (No providedComponentIds)
Used when `computeSynergy()` is called **without** `providedComponentIds`. This path:
1. Delegates to `SynergyComponentGatherer.gatherSameComponentType()`
2. Auto-detects component type from `sourceComponentId`
3. Applies `allowedComponentIds` filtering for client-selected components

### Path 2: `_evaluateProvidedComponents` (With providedComponentIds)
Used when `computeSynergy()` is called **with** `providedComponentIds` (e.g., from action execution). This path:
1. Filters provided components via `_filterProvidedForGroup()`
2. Auto-detects component type from the first valid component in the array
3. Applies role filter + same-type filtering

**Critical:** Both paths must maintain **symmetric filtering behavior** — they should produce the same results for the same inputs.

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

**Problem:** The `SynergyComponentGatherer` methods gathered **ALL matching components on the entity**, not just the source component that was selected. For spatial actions, component selection validation is skipped (so no components are locked), meaning ALL Movement components on the entity contribute to synergy even when only 1 was selected.

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

### Fix 11: GroupType Unification — All Groups Use `sameComponentType` (2026-05-09)

**Problem:** The synergy system had multiple `groupType` values (`movementComponents`, `anyPhysical`, `sameComponentType`) that duplicated filtering logic. Each type required a separate gatherer method with its own type-checking logic.

**Solution:** Unified all `groupType` values to `"sameComponentType"`. The component type is now **auto-detected** from the source component at runtime:

1. **`SynergyComponentGatherer.gatherSameComponentType()`**: Accepts `sourceComponentId` and `allowedComponentIds`. Auto-detects type from source, includes same-type siblings filtered by `allowedComponentIds`.

2. **`synergyController.js`**: `_gatherGroupMembers()` delegates to `gatherSameComponentType()` for all groupTypes. Builds `allowedComponentIds` from `providedComponentIds` to ensure only client-selected components count.

3. **`data/synergy.json`**: All groups now use `"sameComponentType"`. The `componentType` field has been removed — type is inferred at runtime.

**Prevention:** When adding new synergy behaviors, prefer extending the auto-detection logic rather than adding new groupTypes.

### Fix 12: `_filterProvidedForGroup` Type Detection Made Deterministic (2026-05-09)

**Problem:** The `_filterProvidedForGroup` method detected the component type from the **first** component that passed the role filter. This made type detection dependent on array order and component stats, leading to non-deterministic results.

**Example Bug:** If `providedComponentIds` = `[droidArm, droidRollingBall, droidHand]` with `roleFilter: 'source'`, and `droidArm` happened to pass first, all `droidRollingBall` components would be excluded even if they were the intended synergy type.

**Solution:** Changed to a **two-pass** approach:
1. **First pass**: Find the component type from the first valid component in `providedComponentIds` (regardless of roleFilter) — deterministic.
2. **Second pass**: Filter by roleFilter AND same type.

```javascript
// First pass: detect type deterministically
let detectedType = null;
for (const { componentId } of providedComponentIds) {
    if (lockedComponentIds.has(componentId)) continue;
    const component = entity.components.find(c => c.id === componentId);
    if (component) {
        detectedType = component.type;
        break;
    }
}

// Second pass: filter by roleFilter + same type
const validComponents = providedComponentIds
    .filter(({ componentId, role }) => {
        // ... roleFilter check ...
        if (detectedType && component.type !== detectedType) return false;
        return true;
    });
```

**Prevention:** When refactoring synergy filtering logic, always ensure both evaluation paths (`_evaluateComponentGroups` and `_filterProvidedForGroup`) maintain **symmetric filtering behavior**.

### Fix 13: Fallback Path Respects `allowedComponentIds` (2026-05-09)

**Problem:** When `sourceComponentId` was not provided, `gatherSameComponentType()`'s fallback path included ALL components on the entity without filtering by `allowedComponentIds`. This meant non-spatial actions could incorrectly include components the client didn't select.

**Solution:** Added a new branch in the fallback path:
1. If `allowedComponentIds` is provided but no `sourceComponentId`: filter to the allowed set only.
2. If neither is provided: apply roleFilter-based filtering (original behavior).

```javascript
// No sourceComponentId: gather all components (fallback for non-spatial actions).
if (allowedComponentIds && allowedComponentIds.size > 0) {
    // Filter to allowed set only
    const members = entity.components
        .filter(c => !lockedComponentIds.has(c.id) && allowedComponentIds.has(c.id) && ...);
    return members;
}
// Original fallback behavior...
```

**Prevention:** All gather methods must respect `allowedComponentIds` when provided, regardless of whether `sourceComponentId` is set.

## References
- Related wiki: `wiki/subMDs/synergy_preview.md`
- Related controller: `SynergyController`
- Related bug: [BUG-051](../bugfixWiki/architectural/BUG-051-provided-components-missing-type-filter.md)