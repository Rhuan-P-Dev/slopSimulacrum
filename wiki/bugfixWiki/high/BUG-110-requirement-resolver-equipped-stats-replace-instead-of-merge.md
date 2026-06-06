# BUG-110: RequirementResolver Equipped Item Stats Replace Instead of Merge

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `typed-id-equipped-bugs-fix`
- **Related Files**: `src/controllers/actions/RequirementResolver.js` (lines 81-102, 146-160)

## Symptoms

1. **Cut action not working when knife is equipped**: After equipping the knife on the droid's left hand, attempting to use the "cut" action produced: `No component possesses the required Physical.strength (>= 15)`.
2. **Host component stats lost**: The droid's left hand has `Physical.strength: 25` but when the knife (which has `Physical.sharpness: 50` but no `Physical.strength`) was equipped, the host's strength stat was completely lost.
3. **Requirement resolution failed**: The `checkComponentRequirements` and `resolveRequirementValues` methods in `RequirementResolver.js` were replacing host stats with equipped item traits.

## Root Cause

`RequirementResolver.js` had the same stats merge bug as `ComponentCapabilityController.js`. Two methods were replacing host component stats with equipped item traits:

### Bug 1: checkComponentRequirements (Lines 81-102)

```javascript
// BEFORE (WRONG):
componentStats = equipped.traits; // ← REPLACED host stats entirely
resolvingTargetId = eqId;

// AFTER (FIXED):
const hostStats = this.worldStateController.getComponentStats(componentId);
const baseTraits = this.equippedItemStats?.hasStats(eqId)
    ? this.equippedItemStats.getStats(eqId)
    : equipped.traits;
const baseTraitsToUse = baseTraits || equipped.traits;

// Start with host stats (e.g., droidHand has Physical.strength: 25)
const mergedStats = {};
if (hostStats) {
    for (const [trait, data] of Object.entries(hostStats)) {
        mergedStats[trait] = { ...data };
    }
}
// Overlay equipped item traits (knife has Physical.sharpness: 50)
for (const [trait, data] of Object.entries(baseTraitsToUse)) {
    if (!mergedStats[trait]) {
        mergedStats[trait] = { ...data };
    } else {
        for (const [stat, value] of Object.entries(data)) {
            if (mergedStats[trait][stat] === undefined) {
                mergedStats[trait][stat] = value;
            }
        }
    }
}
componentStats = mergedStats;
resolvingTargetId = eqId;
```

### Bug 2: resolveRequirementValues (Lines 146-160)

Same replacement pattern in `resolveRequirementValues` — built a traits map from equipped item only, ignoring host component stats.

## Fix

Applied the same merge logic used in `ComponentCapabilityController._getEffectiveStatsForComponent` to both methods in `RequirementResolver.js`:

1. Start with host component stats (e.g., `Physical.strength: 25`)
2. Overlay equipped item traits (e.g., `Physical.sharpness: 50`)
3. Non-conflicting stats from both sources are preserved
4. `fulfillingComponents` map is correctly keyed with the typed eqId

## Prevention

1. When resolving requirements for a component with an equipped item, always merge host + equipped stats
2. Never replace host stats with equipped item traits
3. The merge logic must be consistent across all controllers that handle equipped items:
   - `ComponentCapabilityController._getEffectiveStatsForComponent`
   - `RequirementResolver.checkComponentRequirements`
   - `RequirementResolver.resolveRequirementValues`

## References

- Related wiki: `wiki/subMDs/systems/typed_id_adoption.md`
- Related bug: `wiki/bugfixWiki/high/BUG-109-equipped-item-stats-lookup-and-merge-issues.md`
- Related bug: `wiki/bugfixWiki/architectural/BUG-108-synthetic-equipped-id-format.md`