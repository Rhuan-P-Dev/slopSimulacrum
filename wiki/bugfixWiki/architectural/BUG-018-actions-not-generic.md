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

### Example: Hardcoded Punch Action

```javascript
// ❌ BEFORE (buggy - hardcoded action)
executePunch(entity) {
    const damage = entity.components[0].stats.strength * 2;
    const range = 1;
    // Apply damage to first enemy component found
    const target = findFirstEnemy(entity);
    target.stats.durability -= damage;
}
```

## Root Cause

The action system was implemented as individual methods in `ActionController`, each with hardcoded logic:

```javascript
// ❌ BEFORE (buggy - hardcoded methods)
class ActionController {
    executePunch(entity) { /* hardcoded logic */ }
    executeKick(entity) { /* hardcoded logic */ }
    executeMove(entity) { /* hardcoded logic */ }
    // ... one method per action
}
```

This violated the **Data-Driven Design** principle from `wiki/code_quality_and_best_practices.md` Section 1.3.

## Fix

Implemented a data-driven action system where actions are defined in JSON configuration files:

```javascript
// ✅ AFTER (fixed - data-driven action)
// data/actions.json
{
    "punch": {
        "requirements": [
            { "trait": "Physical", "stat": "strength", "minValue": 5 }
        ],
        "consequences": [
            {
                "type": "damageComponent",
                "params": {
                    "damage": "-:Physical.strength*2"
                }
            }
        ],
        "targetingType": "source"
    }
}

// ActionController executes ANY action from the registry
executeAction(actionName, entityId, params) {
    const actionData = this.actionRegistry[actionName];
    // Generic execution flow for ALL actions
    const requirements = this._checkRequirements(actionData, entityId);
    const consequences = this._executeConsequences(actionData, context);
}
```

### Data-Driven Architecture

```
data/actions.json (action definitions)
    → DataLoader.loadJsonSafe() → actionRegistry
        → ActionController.executeAction() (generic executor)
            → _checkRequirements() (validates requirements)
            → _executeConsequences() (dispatches to handlers)
            → ConsequenceHandlers (per-type logic)
```

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