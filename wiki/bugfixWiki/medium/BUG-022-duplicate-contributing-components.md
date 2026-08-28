# BUG-022: Duplicate Contributing Components in Synergy Result

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `22bf5dc`
- **Related Files**: `src/controllers/synergyController.js` (lines 410-418, 582-590)

## Symptoms

In the synergy preview "Contributing Components:" section, the same component appeared multiple times — only 2 physical `droidRollingBall` components existed, but 4 entries were shown.

## Root Cause

The `dash` synergy configuration in `data/synergy.json` has **two component groups** (a `sameComponentType` group for `droidRollingBall` and a `movementComponents` group). Both groups matched the same 2 `droidRollingBall` components (they have both the `droidRollingBall` type AND `Movement` traits), so each component was counted once per matching group, producing 4 entries for 2 physical components.

## Fix

Contributing components are now deduplicated by `componentId` before being returned, in both of the SynergyController's evaluation paths, so each component contributes at most once regardless of how many component groups it matches.

## Prevention

When accumulating items from multiple groups/sessions, always deduplicate by a unique identifier before returning results.

## References

- Related wiki: `wiki/subMDs/synergy_system.md`
- Related controller: `SynergyController`