# BUG-049: ConsequenceHandlers SRP Violation — Monolithic Handler Class

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/consequenceHandlers.js`, `src/controllers/SpatialConsequenceHandler.js`, `src/controllers/StatConsequenceHandler.js`, `src/controllers/DamageConsequenceHandler.js`, `src/controllers/LogConsequenceHandler.js`, `src/controllers/EventConsequenceHandler.js`, `src/controllers/EquipmentConsequenceHandler.js`

## Symptoms

The `ConsequenceHandlers` class (397 lines) contained **11 handler methods** across **4 distinct responsibility categories**:
- Spatial operations (`updateSpatial`, `deltaSpatial`)
- Stat operations (`updateStat`, `updateComponentStatDelta`)
- Damage operations (`damageComponent`)
- Equipment operations (`grabItem`, `releaseItem`, `grabToBackpack`, `dropAll`)
- Utility operations (`log`, `triggerEvent`)

This violated the Single Responsibility Principle (SRP) — the class had multiple reasons to change.

## Root Cause

The original `ConsequenceHandlers` was created as a single catch-all class for all action consequence execution. As the game evolved (equipment system, spatial actions), new handlers were added to the same class without refactoring.

## Fix

Split `ConsequenceHandlers.js` into **6 single-focused modules**:

| Module | Handlers | Lines |
|--------|----------|-------|
| `SpatialConsequenceHandler.js` | `updateSpatial`, `deltaSpatial` | ~70 |
| `StatConsequenceHandler.js` | `updateStat`, `updateComponentStatDelta` | ~80 |
| `DamageConsequenceHandler.js` | `damageComponent` | ~40 |
| `LogConsequenceHandler.js` | `log` | ~30 |
| `EventConsequenceHandler.js` | `triggerEvent` | ~25 |
| `EquipmentConsequenceHandler.js` | `grabItem`, `releaseItem`, `grabToBackpack`, `dropAll` | ~300 |

The original `ConsequenceHandlers.js` was refactored into a **lightweight dispatcher** (~62 lines) that:
1. Instantiates all focused handlers via Dependency Injection
2. Exposes a `handlers` getter maintaining the same backward-compatible interface
3. Routes calls to the appropriate focused handler

### Dispatcher Pattern

```javascript
class ConsequenceHandlers {
    constructor(controllers) {
        this.spatialHandler = new SpatialConsequenceHandler(controllers);
        this.statHandler = new StatConsequenceHandler(controllers);
        this.damageHandler = new DamageConsequenceHandler(controllers);
        this.logHandler = new LogConsequenceHandler();
        this.eventHandler = new EventConsequenceHandler();
        this.equipmentHandler = new EquipmentConsequenceHandler(controllers);
    }

    get handlers() {
        return {
            updateSpatial: (t, p, c) => this.spatialHandler._handleUpdateSpatial(t, p, c),
            // ... other handlers
        };
    }
}
```

## Prevention

- New consequence types should be added to the appropriate existing focused module
- If a new category of consequences emerges, create a new focused handler module
- Follow the Dispatcher Pattern for any future handler additions
- Refer to `wiki/subMDs/consequence_handler_architecture.md` for architecture details

## References
- Related wiki: `wiki/subMDs/consequence_handler_architecture.md`
- Related controller: `ConsequenceHandlers`, `ActionController`, `ConsequenceDispatcher`
- Related bug: [BUG-011](medium/BUG-011-srp-violation.md) — ActionController SRP Violation (same category)