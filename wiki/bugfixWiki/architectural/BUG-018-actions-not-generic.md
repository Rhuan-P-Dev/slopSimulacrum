# BUG-018: Hardcoded Actions (Not Data-Driven)

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `462ecc5` ("fix: make actions generic"), `be6858d` ("feat(actions): implement data-driven action system")
- **Related Files**: `data/actions.json`, `src/controllers/actionController.js`

## Symptoms

Actions were hardcoded directly in the controller code:
- Adding a new action required modifying JavaScript code
- Action parameters couldn't be changed without redeploying
- Actions were tied to specific entity/component types
- Testing actions required mocking controller internals

## Root Cause

The action system was implemented as individual methods in `ActionController`, each with hardcoded logic, so the engine could only perform actions for which a method existed. This violated the **Data-Driven Design** principle from `wiki/code_quality_and_best_practices.md` Section 1.3.

## Fix

Implemented a data-driven action system where actions are defined in JSON configuration files and the controller executes them generically from a registry, so adding or tuning actions requires data changes only.

## Prevention

- Never hard-code game logic in controller code
- All game content (actions, components, traits) must be defined in JSON/YAML data files
- Controllers should be generic interpreters of data definitions
- Follow the **Data-Driven Design** principle from `wiki/code_quality_and_best_practices.md` Section 1.3

## References

- Related wiki: `wiki/subMDs/action_system.md`
- Related wiki: `wiki/code_quality_and_best_practices.md` Section 1.3
- Related controller: `ActionController`
- Git commits: `462ecc5`, `be6858d`
- Related bug: [BUG-011](../medium/BUG-011-srp-violation.md)