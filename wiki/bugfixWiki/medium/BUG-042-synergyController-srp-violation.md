# BUG-042: SynergyController SRP Violation — Extracted 4 Modules

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/synergyController.js`, `SynergyConfigManager.js`, `SynergyComponentGatherer.js`, `SynergyCalculator.js`, `SynergyCacheManager.js`

## Symptoms
- `synergyController.js` was 1064 lines handling config management, component gathering, multiplier calculation, and caching
- Violated SRP (wiki/code_quality_and_best_practices.md §1.1)

## Fix Applied
Extracted 4 modules, injected via constructor:

| Module | File | Purpose |
|--------|------|---------|
| SynergyConfigManager | `src/controllers/SynergyConfigManager.js` | Load/validate synergy configs |
| SynergyComponentGatherer | `src/controllers/SynergyComponentGatherer.js` | Gather contributing components from state |
| SynergyCalculator | `src/controllers/SynergyCalculator.js` | Compute multipliers using SynergyScaling curves |
| SynergyCacheManager | `src/controllers/SynergyCacheManager.js` | TTL, eviction, get/set/clear cache |

**Before**: 1064 lines → **After**: ~200 lines (orchestration only)

## Prevention
- Extract new responsibilities into separate modules following DI pattern
- Keep `synergyController.js` as orchestration layer only
- Each module should be testable independently

## References
- Related wiki: `wiki/subMDs/controller_patterns.md`
- Related wiki: `wiki/subMDs/synergy_system.md`
- Related wiki: `wiki/code_quality_and_best_practices.md` §1.1 SRP