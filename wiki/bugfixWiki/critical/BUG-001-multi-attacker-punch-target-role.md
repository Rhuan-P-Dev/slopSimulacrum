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

In `_executeMultiAttackerConsequences()`, the filter for identifying attacker components incorrectly included both `source` AND `target` role components. Enemy/target components were therefore treated as attackers, and when requirement values for damage calculation (e.g., `:Physical.strength`) were resolved, the enemy components didn't have the attacker's strength values, causing damage to be skipped entirely.

## Fix

The attacker filter now includes only `source` role components. Rationale: damage requirements must resolve against the actual attackers; including target components in the attacker set was a pure role misclassification, and excluding targets is the minimal correct correction.

## Prevention

- When implementing multi-component actions, always verify role assignments match the intended logic
- Write integration tests that verify damage values are non-zero for multi-attacker scenarios
- The `ActionController` should log resolved requirement values for debugging

## References

- Related wiki: `wiki/subMDs/action_system.md`
- Related controller: `ActionController`
- Git commit: `b53e0dd`
- Previous buggy commit: `6a088c1` ("feat(actions): buggy - implement multi-attacker punch with independent damage")