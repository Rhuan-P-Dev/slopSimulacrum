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

Implemented a complete Internal Components system so components can contain other components internally:

- **Data-driven definitions** — internal component types are defined in `data/internalComponents.json` (volume, repair interval/amount, traits, excluded host types, auto-install flag) and loaded via the standard `DataLoader` path, so new internal components can be added as data rather than code.
- **Dedicated state controller** — `InternalComponentController` owns internal-component runtime state, auto-installs spheres on eligible components at entity spawn, runs the periodic durability repair tick, enforces volume-based capacity checks, and returns defensive copies, following the State Controller self-instantiation pattern.
- **Entity lifecycle integration** — entities expose an `internalComponents` field; spheres are installed after blueprint expansion and cleaned up on despawn, keeping entity state consistent and leak-free.
- **Public API and REST exposure** — `WorldStateController` integrates the controller via dependency injection and exposes it through its public API, with dedicated REST routes for client access.
- **Client visualization** — a dedicated CSS module renders the spheres with a pulse synced to the repair interval, so the repair effect is visible in the UI.
- **Auto-installation on smallBallDroid** — every non-finger component is auto-installed with a sphere at spawn, giving the droid automatic durability repair; the 6 fingers are deliberately excluded via the data file's exclusion list.

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
