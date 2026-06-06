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
```javascript
// BEFORE (WRONG):
const currentStats = this.worldStateController.equippedItemStats.getStats(equipped.itemId);

// AFTER (FIXED):
const currentStats = this.worldStateController.equippedItemStats.getStats(equipped.eqId);
```
Stats are stored by `eqId` (eq-uuid) but looked up by `itemId` (item-uuid), causing a lookup mismatch.

### Bug 2: Legacy Format in fulfillingComponents (Line 1192)
```javascript
// BEFORE (WRONG):
fulfillingComponents[key] = `equipped-${equipped.itemId}`;

// AFTER (FIXED):
fulfillingComponents[key] = equipped.eqId;
```
Constructed old synthetic format instead of using typed eqId.

### Bug 3: Equipped Item Stats Replaced Instead of Merged (Lines 1125-1134)
```javascript
// BEFORE (WRONG):
_getEffectiveStatsForComponent(componentId) {
    const hostStats = this.worldStateController.componentController.getComponentStats(componentId);
    const equippedTraits = this._getEquippedTraitsForHostComponent(componentId);
    if (equippedTraits) {
        return equippedTraits; // ← REPLACED host stats entirely
    }
    return hostStats || null;
}

// AFTER (FIXED):
_getEffectiveStatsForComponent(componentId) {
    const hostStats = this.worldStateController.componentController.getComponentStats(componentId);
    const equippedTraits = this._getEquippedTraitsForHostComponent(componentId);
    if (equippedTraits) {
        // MERGE equipped item traits with host component stats
        const mergedStats = {};
        if (hostStats) {
            for (const [trait, data] of Object.entries(hostStats)) {
                mergedStats[trait] = { ...data };
            }
        }
        for (const [trait, data] of Object.entries(equippedTraits)) {
            if (!mergedStats[trait]) {
                mergedStats[trait] = { ...data };
            } else {
                for (const [stat, value] of Object.entries(data)) {
                    if (!mergedStats[trait][stat] && value !== undefined) {
                        mergedStats[trait][stat] = value;
                    }
                }
            }
        }
        return mergedStats;
    }
    return hostStats || null;
}
```
When an equipped item's traits were checked, they **fully replaced** the host component's traits. This caused the host's `Physical.strength=25` to be lost, making strength-based requirements fail.

## Fix

1. Changed stats lookup to use `equipped.eqId` (typed eq-uuid) instead of `equipped.itemId`
2. Changed `fulfillingComponents` to use `equipped.eqId` directly
3. Changed `_getEffectiveStatsForComponent` to **merge** equipped item traits with host component stats instead of replacing

## Prevention

1. All equipped item stats lookups must use the typed `eqId`, not `itemId`
2. `fulfillingComponents` must use typed IDs, not synthetic formats
3. When combining host and equipped stats, always merge — never replace

## References
- Related wiki: `wiki/subMDs/systems/typed_id_adoption.md`
- Related bug: `wiki/bugfixWiki/architectural/BUG-108-synthetic-equipped-id-format.md`