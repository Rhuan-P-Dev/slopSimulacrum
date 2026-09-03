# BUG-095: Punch Disappears When Equipping Knife / Reappears After Cut

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `src/controllers/capabilities/componentCapabilityController.js`

## Symptoms

1. When equipping a knife on a hand component, the "droid punch" action becomes hidden (shows "0 capables") even though the hand still has `Physical.strength >= 15`.
2. After executing the cut action with the knife, the punch action reappears.

## Root Cause

The fix for BUG-093/094 introduced a regression. `_checkRequirementsForComponent()` was modified to **always** use `_getEffectiveStatsForComponent()` which returns equipped item traits when the component has one equipped. This caused host components to be evaluated against equipped item stats instead of their own stats.

When scanning host components for the "droid punch" action (which requires Physical.strength), the method returned the knife's traits (sharpness, durability) instead of the hand's traits (strength). Since the knife has no strength trait, the punch requirement check failed and the punch entry was not added to the capability cache.

**Why punch reappeared after cut**: After executing cut, a code path triggered a full capability re-scan that accidentally re-added the punch entry. This was an unintended side effect of the cache rebuild logic, not a correct fix.

**The fix**: A host-only variant of the requirement check was introduced and used for host-component entries during capability scanning, so host components are evaluated against their own stats while equipped-item actions continue to be resolved from item traits by the dedicated equipped-item scan. Rationale: host components and equipped items need different stat sources, and sharing one override path for both contexts is what caused the regression — proper separation between the two evaluation paths is the durable fix.

## Prevention

- Capability scanning for host components must use host-only requirement checking
- Equipped item actions are handled by a separate scan method (`_scanEquippedItemsForActions`)
- Don't share requirement checking logic between host component evaluation and equipped item evaluation without considering the different contexts
- When adding new trait resolution methods, ensure each caller uses the appropriate variant

## References

- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related controller: `ComponentCapabilityController`, `RequirementResolver`
- Related bugs: `BUG-093`, `BUG-094`, `BUG-096`