# BUG-067: Internal Components System — durabilityRepairSphere

- **Severity**: MEDIUM (Feature addition)
- **Status**: ✅ Implemented
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/core/InternalComponentController.js`, `data/internalComponents.json`

## Summary

Implemented the Internal Components system — a volume-based architecture that allows components to contain other components internally. The first internal component is `durabilityRepairSphere`, which auto-installs on every non-finger component of the smallBallDroid and increases its host's durability by +1 every 5 seconds.

## Symptoms

Before this fix, the smallBallDroid had no automatic durability repair mechanism. Components that took damage during gameplay would degrade permanently until manually healed by actions. There was no system for nested/internal components.

## Root Cause

The original architecture only supported flat component hierarchies. Components were leaf nodes with no capacity to contain other components. No internal component system existed.

## Fix

Implemented a complete Internal Components system:

### 1. Data Definition (`data/internalComponents.json`)
```json
{
  "durabilityRepairSphere": {
    "volume": 2,
    "repairInterval": 5,
    "repairAmount": 1,
    "traits": {
      "Physical": { "mass": 5, "durability": 50 }
    },
    "excludedComponentTypes": ["humanoidDroidFinger"],
    "autoInstallOnSpawn": true
  }
}
```

### 2. Server-Side Controller (`src/controllers/core/InternalComponentController.js`)
- State Controller following self-instantiation pattern
- Auto-installs spheres on eligible components at entity spawn
- 5-second repair tick via `setInterval`
- Volume-based capacity checking
- Defensive copying via `structuredClone()`
- Centralized Logger integration

### 3. State Entity Integration (`src/controllers/core/stateEntityController.js`)
- Added `internalComponents` field to entity data
- Auto-installs spheres after blueprint expansion
- Cleans up internal components on despawn

### 4. WorldStateController Integration (`src/controllers/WorldStateController.js`)
- DI integration of InternalComponentController
- Added to `subControllers` map
- Public API methods: `addInternalComponent()`, `getInternalComponents()`, `getInternalComponentsForEntity()`
- Starts repair system after initialization

### 5. REST API (`src/routes/internalComponentRoutes.js`)
- `GET /api/internal-components/:entityId`
- `POST /api/internal-components/:entityId/:hostComponentId/add`
- `DELETE /api/internal-components/:entityId/:hostComponentId/:internalComponentId`

### 6. CSS Styling (`public/css/internal-components.css`)
- Pulsing animation matching repair interval
- Hover glow effects
- Connection line styling

### 7. Auto-Installation on smallBallDroid
8 durabilityRepairSpheres are auto-installed (all non-finger components):
- centralBall, droidHead, droidArm (×2), droidRollingBall (×2), droidHand (×2)
- 6 fingers are excluded via `excludedComponentTypes`

## Prevention

- Internal components follow the State Controller self-instantiation pattern (see `wiki/subMDs/controller_patterns.md` Section 8.2)
- Volume-based installation prevents over-configuration — always validate `hostComponent.volume >= internalComponent.volume` before installation
- Excluded component types list prevents installation on inappropriate components
- Always use `DataLoader.loadJsonSafe()` for data loading — never hardcode internal component definitions
- Implement `cleanupEntity()` for entity lifecycle management to prevent memory leaks
- Use `setWorldStateController()` for DI — never access sub-controllers directly
- Defensive copying via `structuredClone()` on all public data-exposing methods

## References
- Related wiki: `wiki/subMDs/internal_components.md`
- Related controller: `InternalComponentController`
- Related controller pattern: `wiki/subMDs/controller_patterns.md` Section 8.2
- Related bugfix: [BUG-068](BUG-068-component-viewer-missing-internal-components.md) — Component Viewer UI for Internal Components
- Related data: `data/internalComponents.json`, `data/components.json`
