# BUG-113: Equipment ID (eq-*) Not Resolved in Multi-Attacker Consequence Dispatcher

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `ConsequenceDispatcher.js`

## Symptoms

When executing multi-attacker actions (e.g., "punch" with multiple attackers) where one or more attackers are equipped items:

1. **Warning in logs**:
```
⚠️ WARN: [ConsequenceDispatcher] Attacker "eq-c997b01d-146d-4387-90b4-3aae8d14f930" has no Physical.strength — skipping
```

2. **Silent Skip**: The equipped item attacker is skipped entirely
3. **Missing Damage**: No damage is dealt by the equipped item attacker
4. **Incomplete Action**: Action executes but with fewer attackers than expected

## Root Cause

The `ConsequenceDispatcher.executeMultiAttacker()` method tries to get attacker stats using:
```javascript
const attackerStats = this.worldStateController.componentController.getComponentStats(attackerId);
```

This only works for `comp-*` IDs (body parts), not `eq-*` IDs (equipped items). When an equipped item is an attacker:
1. `getComponentStats(eq-abc123...)` returns `null` because equipment IDs aren't in the component stats store
2. The code checks `!attackerStats` and skips the attacker
3. The equipped item's damage is never applied

### Why This Happened

The multi-attacker flow wasn't updated when the equipment ID resolution was added to other systems. The selection system and synergy system were fixed, but the consequence dispatcher was missed.

## Fix

### Updated `executeMultiAttacker()` in `ConsequenceDispatcher.js`

Added equipment ID resolution before stats lookup:

```javascript
// Resolve equipment IDs (eq-*) to host component IDs (comp-*) for stats lookup
let resolvedAttackerId = attackerId;
let attackerStats = null;

if (IdResolver.isEquippedId(attackerId)) {
    // For equipped items, try to get stats from EquippedItemStatsController first
    const equippedItemStats = this.actionController.equippedItemStats;
    if (equippedItemStats && equippedItemStats.hasStats(attackerId)) {
        const itemStats = equippedItemStats.getStats(attackerId);
        if (itemStats && itemStats.Physical && itemStats.Physical.strength !== undefined) {
            attackerStats = itemStats;
        }
    }

    // If not found in equipped item stats, resolve to host component
    if (!attackerStats) {
        const equipped = this.worldStateController.getEquippedItem(entityId, attackerId);
        if (equipped && equipped.componentId) {
            resolvedAttackerId = equipped.componentId;
            attackerStats = this.worldStateController.componentController.getComponentStats(resolvedAttackerId);
        }
    }
} else {
    // For regular components, get stats directly
    attackerStats = this.worldStateController.componentController.getComponentStats(attackerId);
}
```

### Resolution Strategy

1. **First**: Check if the attacker is an equipped item (`eq-*` ID)
2. **Second**: Try to get stats from `EquippedItemStatsController` (for mutable stats like sharpness)
3. **Third**: If not found, resolve to host component ID and get stats from component stats store
4. **Fourth**: If still not found, skip the attacker (original behavior)

## Prevention

1. **Consistent Pattern**: All code that looks up component stats should check for equipment IDs first
2. **Centralized Resolution**: Consider adding a helper method like `_getStatsForAttacker(attackerId, entityId)` that handles both cases
3. **Test Coverage**: Add tests for multi-attacker actions with equipped items
4. **Code Review**: When adding equipment ID support, check all code paths that look up stats

## References

- Related bug: [BUG-111](high/BUG-111-equipment-id-not-resolved-in-selection-system.md)
- Related bug: [BUG-112](high/BUG-112-equipment-id-not-resolved-in-synergy-system.md)
- Related controller: `ConsequenceDispatcher`
- Related controller: `EquippedItemStatsController`
