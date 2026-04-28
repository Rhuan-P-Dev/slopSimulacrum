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

In `ActionScoring.js`, the scoring algorithm calculates an excess ratio:

```javascript
// ❌ BEFORE (division by zero when minValue = 0)
const excessRatio = value / minValue;  // NaN when minValue = 0!
```

When `minValue = 0`, `value / 0 = Infinity` (for positive values) or `NaN` (for zero values).

### Scoring Constants Reference

| Constant | Value | Description |
|----------|-------|-------------|
| `REQUIREMENT_MET` | 1.0 | Base score when requirement is met |
| `REQUIREMENT_EXCEEDED_BONUS` | 0.1 | Bonus multiplier for exceeding threshold |
| `CLOSE_TO_THRESHOLD_PENALTY` | -0.2 | Penalty for being close but not meeting |
| `EXCEEDED_THRESHOLD_MULTIPLIER` | 2.0 | Ratio threshold for bonus activation |

### Division by Zero Path

```javascript
// When minValue = 0 and value = 0:
const satisfied = 0 >= 0;  // true
const excessRatio = 0 / 0;  // NaN
const bonus = NaN > 2.0 ? 0.1 * (NaN - 1) : 0;  // 0 (NaN comparison is false)
// Score = 1.0 + 0 = 1.0 (works by accident)

// When minValue = 0 and value > 0:
const satisfied = 5 >= 0;  // true
const excessRatio = 5 / 0;  // Infinity
const bonus = Infinity > 2.0 ? 0.1 * (Infinity - 1) : 0;  // Infinity!
// Score = 1.0 + Infinity = Infinity (breaks sorting!)
```

## Workaround

Actions should avoid using `minValue: 0` in requirements. Use a very small positive value instead:

```json
// ❌ BAD
{ "trait": "strength", "stat": "power", "minValue": 0 }

// ✅ GOOD
{ "trait": "strength", "stat": "power", "minValue": 0.001 }
```

## Proposed Fix

Add a guard for zero minValue in the scoring algorithm:

```javascript
// ✅ PROPOSED FIX
function calculateScore(value, minValue) {
    if (minValue === 0) {
        // For zero requirements, any defined stat satisfies the requirement
        return value >= 0 ? 1.0 : 0;
    }
    
    const satisfied = value >= minValue;
    if (!satisfied) {
        const ratio = value / minValue;
        return ratio > 0.8 ? -0.2 : 0;
    }
    
    const excessRatio = value / minValue;
    const bonus = excessRatio > 2.0 ? 0.1 * (excessRatio - 1) : 0;
    return 1.0 + bonus;
}
```

## Prevention

- Document minimum/maximum valid values for requirement parameters
- Add unit tests for edge cases (minValue = 0, negative values, NaN)
- Follow the **Strong Typing and Validation** principle from `wiki/code_quality_and_best_practices.md` Section 2.2

## References

- Related wiki: `wiki/subMDs/action_system.md`
- Related wiki: `wiki/subMDs/action_capability_cache.md`
- Related controller: `ActionScoring`
- Related test: `test/actionController_unit_tests.md` (Tests 2.4.1, 2.4.4)