# BUG-096: Knife Sharpness Drain (-999) Not Working

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `src/controllers/actions/RequirementResolver.js`, `src/controllers/core/EquippedItemStatsController.js`, `src/controllers/WorldStateController.js`, `src/controllers/capabilities/componentCapabilityController.js`

## Symptoms

1. When the player uses the knife for the `cut` action, the sharpness drain of `-999` is not visible on the client
2. The client shows "cut: 1 capable" even when sharpness is drained (e.g., -949), when it should show "cut: 0 incapable"
3. The capability cache shows stale base stats instead of current drained stats

## Root Cause

The bug existed across four layers of the server's stat management and capability caching systems:

### Round 1: No Per-Instance Stats Store

There was no per-instance stats store for equipped items. The knife's stats were static from `inventoryItems.json`, so any drain had nowhere to go.

**Fixed**: A dedicated per-instance stats store for equipped items was created so runtime stat changes have a place to live.

### Round 2: Host Component ID in fulfillingComponents

When the frontend sent a host component ID, `RequirementResolver.checkComponentRequirements()` correctly resolved the knife's traits, but stored the host component ID instead of the knife's `itemId` in `fulfillingComponents`. The consequence handler then modified the wrong target.

**Fixed**: The host-component resolution now returns the item's own id alongside its traits, so consequences are routed to the item instead of the host component.

### Round 3: Prefixed ID Missing itemId Resolution

When the frontend sends an "equipped-" prefixed component ID, the method resolved traits correctly but never updated the resolving target ID to the actual `itemId`.

**Fixed**: The prefixed-ID resolution path was corrected the same way — the resolving target is updated to the item's actual id before consequences are routed.

### Round 4: Capability Cache Never Re-evaluates After Sharpness Drain

Even though the sharpness drain was correctly applied to `EquippedItemStatsController`, the capability cache was:

1. **Never notified** of stat changes (no callback from `EquippedItemStatsController`)
2. **Scanned with base stats** from `inventoryItems.json` instead of current stats from `equippedItemStats`

This caused the client to always show "cut: 1 capable" based on base sharpness (50), not current sharpness (-949).

**Fixed**: The stats store now notifies a registered callback whenever a stat changes, the world state wires that callback to re-evaluate the affected entity's capabilities and broadcast, and the capability scan reads current per-instance stats instead of the static item definitions.

## Prevention

When designing systems that modify item stats at runtime:

- Items that need mutable stats have a dedicated per-instance stats store
- Equipped items should NOT rely on static data definitions for stat modifications
- Stat deltas should route to the correct storage based on target identity
- The `fulfillingComponents` map must store the ID of the component that should receive consequences
- **Capability caches must re-evaluate when underlying stats change**
- **Cache scanning must read current stats, not base definitions**
- Follow the Single Responsibility Principle: stat storage concerns should be decoupled from item definition concerns

## References

- Related wiki: `wiki/CORE.md` (Controller patterns), `wiki/subMDs/data/inventory_system.md`
- Related controller: `RequirementResolver`, `EquippedItemStatsController`, `HoldingCostController`, `StatConsequenceHandler`, `ComponentCapabilityController`
- Related data file: `data/inventoryItems.json`, `data/actions.json`