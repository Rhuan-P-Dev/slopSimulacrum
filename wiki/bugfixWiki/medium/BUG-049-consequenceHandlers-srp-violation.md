# BUG-049: ConsequenceHandlers SRP Violation — Monolithic Handler Class

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/consequences/consequenceHandlers.js`, `src/controllers/consequences/SpatialConsequenceHandler.js`, `src/controllers/consequences/StatConsequenceHandler.js`, `src/controllers/consequences/DamageConsequenceHandler.js`, `src/controllers/consequences/LogConsequenceHandler.js`, `src/controllers/consequences/EventConsequenceHandler.js`

## Symptoms

The `ConsequenceHandlers` class (397 lines) contained **11 handler methods** across **4 distinct responsibility categories**:
- Spatial operations (`updateSpatial`, `deltaSpatial`)
- Stat operations (`updateStat`, `updateComponentStatDelta`)
- Damage operations (`damageComponent`)
- Utility operations (`log`, `triggerEvent`)

This violated the Single Responsibility Principle (SRP) — the class had multiple reasons to change.

## Root Cause

The original `ConsequenceHandlers` was created as a single catch-all class for all action consequence execution. As the game evolved, new handlers were added to the same class without refactoring.

## Fix

Split `ConsequenceHandlers.js` into **5 single-focused modules**:

| Module | Handlers | Lines |
|--------|----------|-------|
| `SpatialConsequenceHandler.js` | `updateSpatial`, `deltaSpatial` | ~70 |
| `StatConsequenceHandler.js` | `updateStat`, `updateComponentStatDelta` | ~80 |
| `DamageConsequenceHandler.js` | `damageComponent` | ~40 |
| `LogConsequenceHandler.js` | `log` | ~30 |
| `EventConsequenceHandler.js` | `triggerEvent` | ~25 |

The original `ConsequenceHandlers.js` was refactored into a **lightweight dispatcher** that instantiates the focused handlers via Dependency Injection and routes each consequence type to its handler, while preserving the same interface existing callers already used — so the split required no changes outside the module.

## Prevention

- New consequence types should be added to the appropriate existing focused module
- If a new category of consequences emerges, create a new focused handler module
- Follow the Dispatcher Pattern for any future handler additions
- Refer to `wiki/subMDs/consequence_handler_architecture.md` for architecture details

## References
- Related wiki: `wiki/subMDs/consequence_handler_architecture.md`
- Related controller: `ConsequenceHandlers`, `ActionController`, `ConsequenceDispatcher`
- Related bug: [BUG-011](medium/BUG-011-srp-violation.md) — ActionController SRP Violation (same category)