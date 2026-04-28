# BUG-005: Deep Trait-Level Merge — Stat Overwrite

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: — (architectural fix in ComponentStatsController)
- **Related Files**: `src/controllers/componentStatsController.js`

## Symptoms

When updating one stat within a trait (e.g., `Physical.durability`), other stats in the same trait (e.g., `Physical.mass`, `Physical.strength`) were erased/overwritten.

**Example:**
```javascript
// Entity has Physical trait with: { durability: 100, mass: 50, strength: 25 }
// Action reduces durability by 10
// Result: Physical trait becomes { durability: 90 } — mass and strength LOST!
```

## Root Cause

The `setStats()` method in `ComponentStatsController` performed a shallow merge instead of a deep trait-level merge. When updating one stat, it replaced the entire trait object rather than updating only the specific stat within the trait.

```javascript
// ❌ BEFORE (shallow merge - buggy)
setStats(componentId, traitId, statName, value) {
    this.stats[componentId][traitId] = { [statName]: value };  // Overwrites entire trait!
}
```

## Fix

Implemented deep trait-level merge that updates only the specific stat while preserving other stats in the same trait:

```javascript
// ✅ AFTER (deep merge - fixed)
setStats(componentId, traitId, statName, value) {
    if (!this.stats[componentId]) this.stats[componentId] = {};
    if (!this.stats[componentId][traitId]) this.stats[componentId][traitId] = {};
    this.stats[componentId][traitId][statName] = value;  // Updates only the specific stat
}
```

## Prevention

- Always use deep merge when updating nested data structures
- Follow the **Long-term State Persistence** principle from `wiki/code_quality_and_best_practices.md` Section 6.2
- Write tests that verify sibling properties are preserved after updates

## References

- Related wiki: `wiki/subMDs/traits.md`
- Related controller: `ComponentStatsController`
- Related bug: [BUG-008](../high/BUG-008-state-desync.md)