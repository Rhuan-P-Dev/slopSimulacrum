# BUG-041: EquipmentController SRP Violation — Extracted 2 Modules

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/equipmentController.js`, `HandEquipment.js`, `BackpackInventory.js`

## Symptoms
- `equipmentController.js` was 679 lines handling two distinct concerns (hand grabs + backpack)
- Violated SRP (wiki/code_quality_and_best_practices.md §1.1)

## Fix Applied
Extracted 2 modules, injected via constructor:

| Module | File | Purpose |
|--------|------|---------|
| HandEquipment | `src/controllers/HandEquipment.js` | Hand grab/equip operations |
| BackpackInventory | `src/controllers/BackpackInventory.js` | Backpack storage operations |

**Before**: 679 lines → **After**: ~120 lines (orchestration only)

## Prevention
- Extract new responsibilities into separate modules following DI pattern
- Keep `equipmentController.js` as orchestration layer only
- Each module should be testable independently

## References
- Related wiki: `wiki/subMDs/controller_patterns.md`
- Related wiki: `wiki/subMDs/equipment_system.md`
- Related wiki: `wiki/code_quality_and_best_practices.md` §1.1 SRP