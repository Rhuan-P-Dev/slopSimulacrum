# BUG-109: Equipped Item Stats Lookup, Cut Action, and Strength Requirement Failures

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `typed-id-equipped-bugs-fix`
- **Related Files**: `src/controllers/capabilities/componentCapabilityController.js` (lines 1012, 1125-1155, 1192)

## Symptoms

1. **Knife received a component ID**: Log showed `Equipped knife on component comp-51753c39...` — the equipped item ID was incorrectly using a component ID format instead of an `eq-uuid` format.
2. **Cut action not working**: Even after equipping the knife, the "cut" action was unavailable.
3. **Physical.strength error**: Using the droid's left hand (which had the knife equipped) produced: `No component possesses the required Physical.strength (>= 15)`.

## Root Cause

Three separate bugs in `componentCapabilityController.js`:

### Bug 1: Stats Lookup Used itemId Instead of eqId (Line 1012)
Per-instance stats are stored by `eqId` (eq-uuid) but were looked up by `itemId` (item-uuid), causing a lookup mismatch.

### Bug 2: Legacy Format in fulfillingComponents (Line 1192)
`fulfillingComponents` was constructed with the old synthetic `equipped-<itemId>` format instead of the typed `eqId`.

### Bug 3: Equipped Item Stats Replaced Instead of Merged (Lines 1125-1134)
When an equipped item's traits were resolved, they **fully replaced** the host component's traits. This caused the host's `Physical.strength=25` to be lost, making strength-based requirements fail.

## Fix

Stats lookup and consequence routing were switched to the typed `eqId`, and effective-stats resolution was changed to **merge** equipped item traits with host component stats instead of replacing them. Rationale: the typed ID is the single key under which per-instance stats are stored, and merging preserves the host's own traits (e.g., strength) alongside the item's traits (e.g., sharpness) — replacing silently discarded whichever source had stats the other lacked.

## Prevention

1. All equipped item stats lookups must use the typed `eqId`, not `itemId`
2. `fulfillingComponents` must use typed IDs, not synthetic formats
3. When combining host and equipped stats, always merge — never replace

## References
- Related wiki: `wiki/subMDs/systems/typed_id_adoption.md`
- Related bug: `wiki/bugfixWiki/architectural/BUG-108-synthetic-equipped-id-format.md`