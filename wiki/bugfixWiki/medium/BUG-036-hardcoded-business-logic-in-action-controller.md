# BUG-036: Hardcoded Business Logic in ActionController

- **Severity**: MEDIUM
- **Status**: ⚠️ Known
- **Fixed In**: `—`
- **Related Files**: `src/controllers/actionController.js` (lines 471, 887)

## Symptoms
- Special-case logic for specific action names (`droid punch`) is hardcoded in JavaScript
- Consequence type lists (`['updateSpatial', 'deltaSpatial']`) are hardcoded instead of data-driven
- Adding new actions requires code changes instead of just updating JSON files

## Root Cause
1. **Line 471**: `if (actionName === 'droid punch' && attackerComponentIds.length > 1` — Multi-attacker special case hardcoded
2. **Line 887**: `const spatialTypes = ['updateSpatial', 'deltaSpatial']` — Spatial consequence types hardcoded

These checks violate the Data-Driven Design principle (wiki/code_quality_and_best_practices.md §1.3).

## Fix (Recommended)
1. Move `droid punch` multi-attacker logic to `synergy.json` with a `multiAttacker: true` flag
2. Add `consequenceTypes` metadata to action definitions in `actions.json`
3. Use data-driven routing instead of if/else chains on action names

## Prevention
- Business rules should live in JSON configuration files, not JavaScript
- If/else chains checking action/component names indicate data should be externalized
- Follow SRP: ActionController executes actions, it doesn't define them

## References
- Related wiki: `wiki/subMDs/action_system.md`
- Related wiki: `wiki/code_quality_and_best_practices.md` §1.3 Data-Driven Design