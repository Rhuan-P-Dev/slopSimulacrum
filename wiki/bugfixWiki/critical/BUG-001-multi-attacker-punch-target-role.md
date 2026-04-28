# BUG-001: Multi-Attacker Punch — Target Components Treated as Attackers

- **Severity**: CRITICAL
- **Status**: ✅ Fixed
- **Fixed In**: `b53e0dd` ("fix: filter only source components as attackers and add safety checks")
- **Related Files**: `src/controllers/actionController.js` (lines 197-208)

## Symptoms

When executing a multi-attacker punch action with multiple entities attacking together:
- Enemy/target components were included in the attacker calculation
- Since enemy components don't have the attacker's `Physical.strength` trait, damage was skipped
- **Result: 0 damage** dealt to the target regardless of attacker strength

## Root Cause

In `_executeMultiAttackerConsequences()`, the filter for identifying attacker components incorrectly included both `source` AND `target` role components:

```javascript
// ❌ BEFORE (buggy)
const attackerComponents = entity.components.filter(
    c => c.role === 'source' || c.role === 'target'
);
```

This meant enemy/target components were treated as attackers. When resolving requirement values for damage calculation (e.g., `:Physical.strength`), the enemy components didn't have the attacker's strength values, causing damage to be skipped entirely.

## Fix

Changed the filter to only include `source` role components:

```javascript
// ✅ AFTER (fixed)
const attackerComponents = entity.components.filter(
    c => c.role === 'source'
);
```

## Prevention

- When implementing multi-component actions, always verify role assignments match the intended logic
- Write integration tests that verify damage values are non-zero for multi-attacker scenarios
- The `ActionController` should log resolved requirement values for debugging

## References

- Related wiki: `wiki/subMDs/action_system.md`
- Related controller: `ActionController`
- Git commit: `b53e0dd`
- Previous buggy commit: `6a088c1` ("feat(actions): buggy - implement multi-attacker punch with independent damage")