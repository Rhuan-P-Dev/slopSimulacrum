# BUG-048: Dash with 1 Component Moves 4x and Falsely Triggers 2-Component Synergy

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**:
  - `src/controllers/SynergyComponentGatherer.js` (lines 34-101)
  - `src/controllers/synergyController.js` (lines 64-98, 158-210, 223-262)
  - `data/synergy.json` (lines 18-41)

## Symptoms

With 1 component:
1. Entity has 1 `droidRollingBall` (move=10)
2. Dash action triggers
3. Synergy multiplier incorrectly computed as > 1.0
4. Total multiplier = **1.0**

With 2 components (but only 1 selected):
1. Entity has 2 `droidRollingBall` components
2. Only 1 is selected for the action
3. Synergy incorrectly includes both (multiplier = 1.5)
4. Final speed = 10 × 2 × 1.5 = **30** (should be 20)

## Root Cause

The `SynergyComponentGatherer` methods gathered **ALL matching components on the entity**, not just the source component that was selected. For spatial actions, component selection validation is skipped (so no components are locked), meaning ALL Movement components on the entity contribute to synergy even when only 1 was selected.

**Expected behavior:**
- 1 droidRollingBall: synergy = 1.0x → speed = 20
- 2 droidRollingBalls: synergy = 1.5 × 1.3 = 1.95x → speed = 39

**Actual behavior before fix:**
- 1 droidRollingBall: synergy = 1.5 × 1.3 = 1.95x → speed = 39 ❌
- 2 droidRollingBalls: synergy = 1.5 × 1.3 = 1.95x → speed = 39 ✅

## Fix (Round 2: Post groupType Unification)

1. **`SynergyComponentGatherer.js`** — The gather methods now respect an `allowedComponentIds` filter: when components are explicitly provided for the action, only those count toward synergy — same-type siblings on the entity are no longer auto-included.
2. **`synergyController.js`** — Provided components are filtered to a single component type (auto-detected from the provided components, since the static type field was removed from the config), and an allowed-ID set built from the provided components is passed down to the gatherer.
3. **`data/synergy.json`** — All groups now use `groupType: "sameComponentType"` without a static `componentType` field; the component type is auto-detected from the source component at runtime, removing the risk of a stale or mismatched configured type.
4. **`actionController.js`** — The preview path now passes the source component ID into the synergy computation, so previews reflect what actual execution will do.
5. **`synergyRoutes.js`** — Both synergy preview routes pass the source component ID in the same way.

## Prevention

1. **Gatherer methods must respect `allowedComponentIds`**: When a set of allowed component IDs is provided, only those specific components should count toward synergy — never auto-include all same-type siblings from the entity.

2. **`_filterProvidedForGroup` must auto-detect component type**: Since `componentType` is no longer in synergy config, the filter must detect the type from the first valid component and only include same-type components.

3. **Preview paths must match execution paths**: `previewActionData()` and the `/synergy/preview` API endpoint must pass the same parameters as `executeAction()` to ensure consistent results.

4. **Test with single-component scenarios**: Always verify synergy computation with exactly 1 selected component to ensure the multiplier is 1.0.

## References