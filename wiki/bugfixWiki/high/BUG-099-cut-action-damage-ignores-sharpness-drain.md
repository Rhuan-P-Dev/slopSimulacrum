# BUG-099: Knife Cut Damage Always Uses Base Sharpness (50), Ignoring Sharpness Drain

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/consequences/DamageConsequenceHandler.js`, `src/controllers/consequences/consequenceHandlers.js`, `src/controllers/WorldStateController.js`

## Symptoms

When the knife is equipped (sharpness = 50 from `inventoryItems.json`):
- **First cut**: Deals 50 damage ✓ (sharpness is 50)
- **Second cut**: Deals 50 damage ✗ (sharpness is actually 49, but still deals 50)
- **Subsequent cuts**: Always deal 50 damage ✗ (sharpness keeps draining to 48, 47, etc., but damage never changes)

The sharpness drain consequence (`-1` per cut) was not properly routing to the equipped item's mutable stats. The consequence handler chain was missing proper routing for equipped item damage.

## Root Cause

Three interconnected wiring issues in the consequence handler chain prevented proper equipped item stat routing:

### 1. `DamageConsequenceHandler` Lacked Equipped Item Routing

The damage handler only accepted `worldStateController` in its constructor. It had no access to `EquippedItemStatsController`, so when the target was an equipped item's eqId, damage was always applied to the host component instead of the item itself.

### 2. `ConsequenceHandlers` Constructor Didn't Pass `equippedItemStats`

The `ConsequenceHandlers` constructor received only the world-state controller. It built the `StatConsequenceHandler` from that incomplete dependency set and relied on post-construction injection; the `DamageConsequenceHandler` received the same incomplete set.

### 3. `WorldStateController` Stat Change Callback Had Wrong Iteration

The stat change callback iterated over `getAllEquippedItems()` using `Object.entries(items)`, which is correct for the nested object returned by `HoldingCostController.getAllEquippedItems()`. However, `WorldStateController.getAllEquippedItems()` returns a flattened array **without** the `eqId` field, making it impossible for the callback to match eqIds from `EquippedItemStatsController._notifyStatChange`.

## Fix

### 1. `src/controllers/consequences/DamageConsequenceHandler.js`

The handler now receives the equipped-stats store at construction and, when the damage target is an equipped item with tracked stats, routes the stat delta to the item itself instead of falling through to the host component.

### 2. `src/controllers/consequences/consequenceHandlers.js`

The stat and damage handlers are now constructed with the equipped-stats store included, rather than relying on partial objects plus post-construction injection.

### 3. `src/controllers/WorldStateController.js`

The world-state controller now passes the equipped-stats store when constructing the consequence handlers, and the redundant post-construction injection was removed. Its stat-change callback identifies the owning entity by direct key lookup against the nested equipped-items structure instead of iterating entries, and the flattened `getAllEquippedItems()` result includes the `eqId` field so the lookup can match.

## Prevention

1. **Always inject equipped item stats at construction time** — never rely on post-construction injection when the injected dependency is needed in the constructor.
2. **Verify iteration patterns** — when a callback passes `eqId` as a parameter, ensure the data source's return format matches the iteration pattern used.
3. **Include all identifiers in flattened data** — public API methods that flatten nested structures should include all relevant identifiers (especially `eqId`).

## References

- Related wiki: `wiki/subMDs/systems/sharpness_system.md`
- Related controller: `DamageConsequenceHandler`, `StatConsequenceHandler`, `ConsequenceHandlers`, `EquippedItemStatsController`
- Related bug: [BUG-096](high/BUG-096-knife-sharpness-drain-not-working.md) — sharpness drain not applied at all
- Related bug: [BUG-097](high/BUG-097-cut-action-disappears-after-use.md) — capability cache staleness