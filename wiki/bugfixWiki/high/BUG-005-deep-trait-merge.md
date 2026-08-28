# BUG-005: Deep Trait-Level Merge — Stat Overwrite

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: — (architectural fix in ComponentStatsController)
- **Related Files**: `src/controllers/componentStatsController.js`

## Symptoms

When updating one stat within a trait (e.g., `Physical.durability`), other stats in the same trait (e.g., `Physical.mass`, `Physical.strength`) were erased/overwritten.

## Root Cause

The `setStats()` method in `ComponentStatsController` performed a shallow merge instead of a deep trait-level merge. When updating one stat, it replaced the entire trait object rather than updating only the specific stat within the trait — so any single stat delta silently destroyed the trait's other stats.

## Fix

Implemented a deep trait-level merge so that a stat update mutates only that single stat's value while every sibling stat in the same trait is preserved. This matters because stats are updated incrementally over many actions (e.g., repeated durability drain); a full-object replacement turns each incremental update into a destructive reset of unrelated data.

## Prevention

- Always use deep merge when updating nested data structures
- Follow the **Long-term State Persistence** principle from `wiki/code_quality_and_best_practices.md` Section 6.2
- Write tests that verify sibling properties are preserved after updates

## References

- Related wiki: `wiki/subMDs/traits.md`
- Related controller: `ComponentStatsController`
- Related bug: [BUG-008](../high/BUG-008-state-desync.md)