# BUG-071: Internal Component Tick System — SRP Violation / Lack of Data-Driven Design

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `InternalComponentController.js`, `data/internalComponents.json`

## Symptoms

1. `_processRepairTick()` was hardcoded for `durabilityRepairSphere` only
2. `repairAmount` and `repairInterval` were single scalar values, not extensible
3. Adding a new internal component type required modifying controller code
4. Violated Data-Driven Design principle (wiki/project_rules.md, wiki/code_quality_and_best_practices.md)

## Root Cause

The original `_processRepairTick()` method used hardcoded checks for a single component type and a single stat. This meant each new internal component effect type required code changes.

## Fix

Replaced the hard-coded repair system with a **generic data-driven unified tick system**: component definitions now declare a tick interval plus a list of declarative effects (target trait, target stat, operation, amount), and the controller applies whatever effects are declared for any component type, so new internal component effects are pure data changes.

### New Component: `transcendentSpeedCore`

Added to demonstrate the generic system with a non-repair effect (a movement stat boost restricted to one entity type), proving that new component effects no longer require controller changes.

## Prevention

- All internal component effects must be defined in `data/internalComponents.json`
- Controller code only reads the registry and applies effects generically
- Adding a new effect type requires only a registry entry, no code changes

## References

- Related wiki: `wiki/subMDs/controllers/internal_component_controller.md`
- Related wiki: `wiki/subMDs/data/components_and_entities.md`
- Related controller: `InternalComponentController`