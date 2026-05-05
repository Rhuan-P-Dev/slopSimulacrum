# Consequence Handler Architecture

## Overview

The consequence handler system was refactored from a single monolithic class (`ConsequenceHandlers.js`) into **6 single-focused modules** following the **Single Responsibility Principle (SRP)**. The original class contained 11 handler methods spanning 4 distinct responsibility categories (397 lines). The new architecture distributes these across dedicated modules while maintaining backward compatibility via a lightweight dispatcher.

## Module Structure

```
src/controllers/
├── consequenceHandlers.js          ← Lightweight dispatcher (~50 lines)
├── SpatialConsequenceHandler.js    ← Spatial coordinate updates (~70 lines)
├── StatConsequenceHandler.js       ← Stat value updates (~80 lines)
├── DamageConsequenceHandler.js     ← Damage application (~40 lines)
├── LogConsequenceHandler.js        ← Logging (~30 lines)
├── EventConsequenceHandler.js      ← Event triggering (~25 lines)
└── EquipmentConsequenceHandler.js  ← Equipment operations (~300 lines)
```

## Module Responsibilities

| Module | Handlers | Responsibility |
|--------|----------|----------------|
| `SpatialConsequenceHandler` | `updateSpatial`, `deltaSpatial` | Entity spatial state changes (absolute and relative positioning) |
| `StatConsequenceHandler` | `updateStat`, `updateComponentStatDelta` | Stat modifications on components and entities |
| `DamageConsequenceHandler` | `damageComponent` | Damage application to specific target components |
| `LogConsequenceHandler` | `log` | Structured log messages at specified severity levels |
| `EventConsequenceHandler` | `triggerEvent` | Event triggering for logging/notification |
| `EquipmentConsequenceHandler` | `grabItem`, `releaseItem`, `grabToBackpack`, `dropAll` | Equipment grab, release, and drop operations |

## Dispatcher Pattern

`ConsequenceHandlers.js` acts as a **lightweight dispatcher** that:
1. Instantiates all focused handlers via Dependency Injection
2. Exposes a `handlers` getter that maps consequence types to handler functions
3. Maintains the normalized signature: `(targetId, params, context)`

```javascript
// Backward-compatible access pattern:
this.actionController.consequenceHandlers.handlers[consequence.type](targetId, params, context)
```

## Handler Interface Contract

All handlers follow a normalized signature and return format:

```javascript
/**
 * @param {string} targetId - The entity/component ID to operate on.
 * @param {Object} params - Handler-specific parameters.
 * @param {Object} context - Context containing actionParams, fulfillingComponents, synergyResult.
 * @returns {Object} { success: boolean, message: string, data: any }
 */
```

## Dependencies

| Module | Dependencies |
|--------|-------------|
| `SpatialConsequenceHandler` | `worldStateController`, `MIN_MOVEMENT_DISTANCE` |
| `StatConsequenceHandler` | `worldStateController` |
| `DamageConsequenceHandler` | `worldStateController` |
| `LogConsequenceHandler` | `Logger` (standalone utility) |
| `EventConsequenceHandler` | `Logger` (standalone utility) |
| `EquipmentConsequenceHandler` | `worldStateController`, `MIN_STRENGTH_DELTA` |

## Integration Points

- **ActionController**: Accesses handlers via `this.consequenceHandlers.handlers`
- **ConsequenceDispatcher**: Iterates action consequences and calls each handler by type
- **WorldStateController**: Instantiates `ConsequenceHandlers` which auto-initializes all sub-handlers

## Benefits of Refactoring

1. **SRP Compliance**: Each module has exactly one reason to change
2. **Testability**: Individual handlers can be tested in isolation
3. **Maintainability**: Changes to equipment logic don't risk spatial logic
4. **Discoverability**: Developers can find relevant code by module name
5. **Backward Compatibility**: Existing `handlers` map access pattern unchanged

## Related Documentation

- [Controller Patterns](controller_patterns.md) — Dependency Injection standard
- [Action System](action_system.md) — Action execution flow
- [Code Quality](../code_quality_and_best_practices.md) — SRP and clean code standards

## Recent Changes

| Date | Change |
|------|--------|
| 2026-05-05 | **Refactored:** Split `consequenceHandlers.js` into 6 focused modules |