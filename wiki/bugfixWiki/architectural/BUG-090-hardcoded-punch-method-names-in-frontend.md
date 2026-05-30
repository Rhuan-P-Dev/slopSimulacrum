# BUG-090: Hardcoded Punch Method Names in Frontend — Not Generic for New Attack Types

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/ActionManager.js`, `public/js/ActionExecutor.js`, `src/controllers/actions/actionController.js`

## Symptoms

Adding a new component-targeted attack action to `data/actions.json` required frontend and backend code to call `executePunch()` or `executeMultiPunch()` specifically. The backend checked `actionName === 'droid punch'` to enable multi-attacker synergy, meaning only that one action could use cooperative attacks. This violated the data-driven principle established by BUG-089.

## Root Cause

`ActionManager.js` had method names hardcoded to "punch" (`executePunch` for single attacker, `executeMultiPunch` for multi-attacker). The backend `actionController.js` checked for the specific action name `'droid punch'` to enable multi-attacker synergy. This meant only the `droid punch` action could benefit from multi-attacker synergy, and any new attack type would need its own method names and backend checks.

## Fix

1. `ActionManager.js`: Renamed methods to generic names — `executePunch()` → `executeComponentAttack()`, `executeMultiPunch()` → `executeMultiComponentAttack()`.
2. `ActionExecutor.js`: Updated all calls to use the renamed methods.
3. `actionController.js`: Replaced hardcoded action name check with `action.targetingType === 'component'`.
4. `data/actions.json`: Updated `cut` action to use component targeting, automatically benefiting from the generic system.

## Prevention

1. **Method names must describe the pattern, not the action** — use `executeComponentAttack` not `executePunch`
2. **Backend checks must use `targetingType`, not action names** — `action.targetingType === 'component'`
3. **Adding new attacks requires only `data/actions.json` changes** — if frontend code changes are needed, this is a bug

## References

- Related wiki: `wiki/subMDs/architecture/attack_system.md`
- Related bug: `wiki/bugfixWiki/architectural/BUG-089-hardcoded-punch-handler-in-frontend.md`
- Related controller: `ActionManager`, `ActionExecutor`, `ActionController`