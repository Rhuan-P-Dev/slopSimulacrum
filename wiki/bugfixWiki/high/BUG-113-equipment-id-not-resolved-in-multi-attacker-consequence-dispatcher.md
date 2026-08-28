# BUG-113: Equipment ID (eq-*) Not Resolved in Multi-Attacker Consequence Dispatcher

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `ConsequenceDispatcher.js`

## Symptoms

When executing multi-attacker actions (e.g., "punch" with multiple attackers) where one or more attackers are equipped items:

1. **Warning in logs**: `⚠️ WARN: [ConsequenceDispatcher] Attacker "eq-c997b01d-146d-4387-90b4-3aae8d14f930" has no Physical.strength — skipping`

2. **Silent Skip**: The equipped item attacker is skipped entirely
3. **Missing Damage**: No damage is dealt by the equipped item attacker
4. **Incomplete Action**: Action executes but with fewer attackers than expected

## Root Cause

The `ConsequenceDispatcher.executeMultiAttacker()` method fetches attacker stats from the component stats store (`componentController.getComponentStats(attackerId)`), which only contains `comp-*` IDs — an `eq-*` ID returns `null`, so the `!attackerStats` check skips the equipped-item attacker and its damage is never applied.

### Why This Happened

The multi-attacker flow wasn't updated when the equipment ID resolution was added to other systems. The selection system and synergy system were fixed, but the consequence dispatcher was missed.

## Fix

### Updated `executeMultiAttacker()` in `ConsequenceDispatcher.js`

Attacker stats are now resolved through a dedicated path for equipped items instead of the raw component stats lookup, so `eq-*` attackers are no longer silently dropped.

### Resolution Strategy

For an `eq-*` attacker, stats are first read from `EquippedItemStatsController` (which holds mutable per-instance stats like sharpness); if absent, the ID is resolved to the host component and looked up in the component stats store; if still not found, the attacker is skipped as before. The item-level store must win because equipped items carry their own mutable stats that diverge from the host component's static stats.

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
