# BUG-071: Internal Component Tick System — SRP Violation / Lack of Data-Driven Design

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `InternalComponentController.js`, `data/internalComponents.json`

## Symptoms

1. `_processRepairTick()` was hardcoded for `durabilityRepairSphere` only
2. `repairAmount` and `repairInterval` were single scalar values, not extensible
3. Adding a new internal component type required modifying controller code
4. Violated Data-Driven Design principle (wiki/project_rules.md, wiki/code_quality_and_best_practices.md)

## Root Cause

The original `_processRepairTick()` method used hardcoded checks:
```javascript
if (internalComp.type !== 'durabilityRepairSphere') continue;
const repairAmount = sphereDef.repairAmount;
// ... hardcoded Physical.durability update
```

This meant each new internal component effect type required code changes.

## Fix

Replaced the hard-coded repair system with a **generic data-driven unified tick system**:

### Before (hard-coded):
```javascript
// Old schema
"durabilityRepairSphere": {
  "repairInterval": 5,
  "repairAmount": 1,
  ...
}

// Old method
_processRepairTick() {
  // Hardcoded for durabilityRepairSphere only
  // Hardcoded Physical.durability stat
}
```

### After (data-driven):
```javascript
// New schema
"componentTypeName": {
  "tickInterval": 5,
  "tickEffects": [
    { "targetTrait": "Physical", "targetStat": "durability", "effect": "add", "amount": 1 },
    { "targetTrait": "Movement", "targetStat": "move", "effect": "add", "amount": 1 }
  ],
  ...
}

// New generic method
_processUnifiedTick() {
  // Iterates ALL component types, checks tickInterval via modulo
  // Applies ALL tickEffects via _applyTickEffect()
}
```

### New Effect Types

| Effect | Behavior |
|--------|----------|
| `add` | Adds amount to stat |
| `set` | Sets stat to exact value |
| `multiply` | Multiplies stat by amount |

### New Component: `transcendentSpeedCore`

Added "Minor Transcendence of the God of Speed" — increases `Movement.move` by 1 every 10 seconds on `smallBallDroid` entities only, demonstrating the new generic system in action.

## Prevention

- All internal component effects must be defined in `data/internalComponents.json`
- Controller code only reads the registry and applies effects generically
- Adding a new effect type requires only a registry entry, no code changes

## References

- Related wiki: `wiki/subMDs/controllers/internal_component_controller.md`
- Related wiki: `wiki/subMDs/data/components_and_entities.md`
- Related controller: `InternalComponentController`