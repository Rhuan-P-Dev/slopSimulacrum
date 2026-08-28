# BUG-103: Dead Code in Controllers — Multiple Files

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: 
  - `src/controllers/actions/ComponentResolver.js` (lines 229-231)
  - `src/controllers/core/componentStatsController.js` (lines 58-64)
  - `src/controllers/consequences/DropItemHandler.js` (line 13, line 134)
  - `src/controllers/actions/actionSelectController.js` (lines 3-21, line 629)

## Symptoms

Dead code exists across 4 controller files:

1. **ComponentResolver._getActionRegistry()** — Method always returns `null`, making `validateComponentBinding()` always fall back to `'unknown'` for action names
2. **ComponentStatsController.updateStat()** — Public method never called from any other file
3. **DropItemHandler.js dead import** — Imports `DROP_BASE_RANGE` and `DROP_RANGE_MULTIPLIER` but never uses them
4. **DropItemHandler.js dead re-export** — Re-exports constants it never uses
5. **actionSelectController.js dead exports** — `BINDING_ROLES` and `DEFAULT_SELECTION_TTL_MS` exported but never imported by any other file

## Root Cause

Accumulated technical debt from refactoring and feature development without systematic dead code detection. Methods were left behind after their callers were removed or changed.

## Fix

Removed the dead methods, unused imports/re-exports, and exports without consumers listed in Symptoms, so the controller surface matches the actual call graph.

## Prevention

Periodic automated dead code analysis using tools like `knip` or `eslint-plugin-unused-imports`. The wiki's Architecture section should be updated to include a "Dead Code Registry" that tracks known cleanup items.

## References

- Related wiki: `wiki/project_rules.md` (Continuous Refactoring mandate)
- Related controller: All affected controllers