# BUG-052: Controllers Directory Structure SRP Violation

| Field | Value |
|-------|-------|
| **Severity** | Architectural |
| **Status** | ✅ Fixed |
| **Fixed In** | `pending` |
| **Related Files** | `src/controllers/` (all 30 files) |

---

## 📋 Symptoms

- All 30 controller files were flat in `src/controllers/` directory
- No logical grouping by subsystem (actions, synergy, equipment, consequences, etc.)
- Difficult for new developers to locate specific controllers
- No barrel export for clean imports
- Violates the principle of organized, maintainable codebase structure

## 🔍 Root Cause

The controllers were extracted into single-focused modules (per BUG-041, BUG-042, BUG-049) but were never organized into a corresponding directory structure. The extracted files remained flat alongside their parent controllers.

## 🛠️ Fix

### New Directory Structure

```
src/controllers/
├── WorldStateController.js          # Root injector (stays at top level)
├── index.js                         # Barrel export (NEW)
│
├── core/                            # Core state management
│   ├── RoomsController.js
│   ├── stateEntityController.js
│   ├── entityController.js
│   ├── ComponentController.js
│   └── ComponentStatsController.js
│
├── traits/                          # Traits subsystem
│   └── TraitsController.js
│
├── actions/                         # Action execution system
│   ├── ActionController.js
│   ├── actionSelectController.js
│   ├── ComponentResolver.js
│   ├── RequirementResolver.js
│   └── RangeValidator.js
│
├── capabilities/                    # Capability caching system
│   └── ComponentCapabilityController.js
│
├── synergy/                         # Synergy computation system
│   ├── SynergyController.js
│   ├── SynergyConfigManager.js
│   ├── SynergyComponentGatherer.js
│   ├── SynergyCalculator.js
│   └── SynergyCacheManager.js
│
├── equipment/                       # Equipment/grab system
│   ├── EquipmentController.js
│   ├── HandEquipment.js
│   └── BackpackInventory.js
│
├── consequences/                    # Consequence handling system
│   ├── ConsequenceHandlers.js
│   ├── ConsequenceDispatcher.js
│   ├── DamageConsequenceHandler.js
│   ├── StatConsequenceHandler.js
│   ├── SpatialConsequenceHandler.js
│   ├── LogConsequenceHandler.js
│   ├── EventConsequenceHandler.js
│   └── EquipmentConsequenceHandler.js
│
└── networking/                      # Network/communication layer
    ├── SocketLifecycleController.js
    └── LLMController.js
```

### Import Path Updates

All internal controller imports updated to use correct relative paths:

| Old Import Path | New Import Path |
|----------------|-----------------|
| `./componentController.js` | `./core/componentController.js` |
| `./traitsController.js` | `./traits/TraitsController.js` |
| `./actionController.js` | `./actions/actionController.js` |
| `./consequenceHandlers.js` | `./consequences/consequenceHandlers.js` |
| `./synergyController.js` | `./synergy/synergyController.js` |
| `./equipmentController.js` | `./equipment/equipmentController.js` |
| `./componentCapabilityController.js` | `./capabilities/componentCapabilityController.js` |
| `./LLMController.js` | `./networking/LLMController.js` |
| `./SocketLifecycleController.js` | `./networking/SocketLifecycleController.js` |

### Barrel Export

Created `src/controllers/index.js` providing a single entry point:

```javascript
import { WorldStateController, ActionController, SynergyController } from '@controllers';
```

### Files Modified

- `src/controllers/WorldStateController.js` — 12 import paths updated
- `src/controllers/core/componentController.js` — 1 import path updated
- `src/controllers/actions/actionController.js` — 1 import path updated
- `src/server.js` — 2 import paths updated
- `test/actionController.test.js` — 1 import path updated
- `test/synergyController.test.js` — 1 import path updated
- `test/componentCapabilityController.test.js` — 1 import path updated
- `wiki/map.md` — Changes log updated

## ✅ Prevention

- New controllers must be placed in the appropriate subdirectory
- Barrel export (`index.js`) must be updated when adding new controllers
- Import paths should use relative paths from the same folder when possible
- Cross-folder imports must use the full path (e.g., `../core/componentController.js`)

## 📝 Notes

- Zero functional changes — purely structural reorganization
- All existing tests pass with updated import paths
- The barrel export enables clean imports but is optional (direct imports still work)
- This completes the SRP pattern initiated by BUG-041, BUG-042, BUG-049