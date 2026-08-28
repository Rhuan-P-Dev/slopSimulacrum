# BUG-015: Division by Zero in Action Scoring (minValue = 0)

- **Severity**: MEDIUM
- **Status**: ⚠️ Known (unresolved)
- **Fixed In**: —
- **Related Files**: `src/utils/ActionScoring.js`

## Symptoms

When an action has a requirement with `minValue: 0`:
- The scoring algorithm produces `NaN` (Not a Number)
- The action scores as `NaN` instead of a valid score
- The action may appear as both the best and worst option in capability sorting

## Root Cause

In `ActionScoring.js`, the scoring algorithm computes an excess ratio by dividing the actual stat value by `minValue`. When `minValue = 0`, that division produces `Infinity` (for positive values) or `NaN` (for zero values), which corrupts the score and breaks capability sorting.

## Workaround

Actions should avoid using `minValue: 0` in requirements; use a very small positive threshold instead so the excess-ratio division stays finite.

## Proposed Fix

Add a guard for zero `minValue` in the scoring algorithm: a zero requirement is satisfied by any defined stat (base score only, no excess bonus), and the excess-ratio math is applied only when `minValue > 0`.

## Prevention

- Document minimum/maximum valid values for requirement parameters
- Add unit tests for edge cases (minValue = 0, negative values, NaN)
- Follow the **Strong Typing and Validation** principle from `wiki/code_quality_and_best_practices.md` Section 2.2

## References

- Related wiki: `wiki/subMDs/action_system.md`
- Related wiki: `wiki/subMDs/action_capability_cache.md`
- Related controller: `ActionScoring`
- Related test: `test/actionController_unit_tests.md` (Tests 2.4.1, 2.4.4)