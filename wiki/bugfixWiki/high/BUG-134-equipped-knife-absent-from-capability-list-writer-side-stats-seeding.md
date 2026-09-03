# BUG-134: Equipped Knife Absent from the Capability List — Per-Instance Stats Never Seeded from Matter

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/core/HoldingCostController.js`, `src/controllers/core/EquippedItemStatsController.js`, `test/contract/equippedKnifeCapability.contract.test.js`

## Symptoms
After [BUG-133](BUG-133-knife-cannot-be-equipped-massburden-contract-drift.md) made the knife equippable and made the capability/requirement *readers* resolve equipped items, the `cut` capability still never appeared for an equipped knife in the ⚔️ actions panel — the list showed only the droid's own components. The equipped knife was present in world state, had passed the equip gate, and was correctly stored, yet every live-stats-first reader saw it as incapable of `cut`. A user could not select the knife to cut.

## Root Cause
A **writer-side initialization gap at equip time** — the third instance of the BUG-133 contract-drift class. The readers were right, and the per-instance store was right *for what it was told*; the writer simply never told the store the item's true starting stats.

In the recipe→derivation model a recipe declares structure, not values. A post-migration item like the knife declares **no explicit traits**; its base stats (existence, the channel resistances, mass, and — for the knife — a depletable sharpness) are *derived* from its matter. The per-instance stat store is the single place where wear and drain accumulate, and the readers read from it with a fixed precedence: the item's current per-instance stats → the recipe's static base traits → a clean skip.

At equip time, the writer called the store's *initialize* routine, which seeds only what a recipe declares **explicitly**. For a post-migration item that is nothing, so the store was left at its existence-only baseline — no sharpness. The readers, honoring their "live stats first" contract, saw that baseline (which is present/truthy), never consulted the matter derivation, scored the knife against `cut`'s sharpness requirement as zero, and skipped it. Crucially, the equip flow already derives the knife's **mass** from the very same matter for the equip gate and then discards the rest of the derivation; nothing ever copied the matter-derived stats into the per-instance store.

So the data existed, the readers were correct, and the store was correct — but the store was never seeded from the item's real source of base traits.

## Fix
Close the gap at the **writer side**: at equip time, after the per-instance store is initialized, when the item's recipe declares **no explicit traits** but **does declare matter**, seed the store's starting stats from the matter derivation — the same derivation the equip gate already performs.

The precedence is preserved and made explicit:

- **Explicit recipe traits** (the initialize routine's job) outrank everything. A recipe that hand-declares traits keeps those authoritative values; the seeding step never overwrites them.
- **Matter derivation** fills in only when no explicit traits exist — it is the post-migration source of base traits.
- **The existence baseline** is the floor. If matter derivation yields nothing usable (no matter, or no derived stats), the baseline is left untouched — graceful degradation, and a capability is never invented.

This keeps the per-instance store a **pure data store** (it still only receives seeded values; it does no derivation itself), uses the same facade-access pattern the equip controller already relies on for mass (no new constructor dependency, no composition-root or architecture-map change), and logs the seeding through the centralized logger. Because the seeding runs before the equip flow's own capability re-evaluation, the freshly-seeded stats are exactly what the scan reads: the knife now legitimately surfaces `cut`, with a sharpness that has a value for the round-1 drain path to actually drain from.

## Related observations (not fixed here)
- **RequirementResolver host-path attribution.** When an item is equipped on a host component, the host-component resolution path merges the host's own stats with the item's. If the host's *own* matter-derived sharpness satisfies `cut`, the requirement can be attributed to the item's equipped-id even though the value came from the host. That is a resolver-attribution nuance, not a seeding gap, and is out of scope here.
- **Pre-fix existence-only stats are orphaned, not re-seeded.** The per-instance store is serialized via `equippedItemStats.getAll()` and restored on save/load ([WorldStateController.js](../../../src/controllers/WorldStateController.js)). A world saved before this fix keeps the knife's existence-only stats, and — because re-equipping generates a *new* `eqId` while the unequip path never removes the old entry — that old entry is *orphaned*: it persists across every subsequent save/load, and a post-fix save/load does **not** heal it (it is never re-seeded, and no live equipped item maps to its `eqId` anymore). **Named follow-up (not implemented here):** prune stats entries whose `eqId` no longer maps to a live equipped item during load. No action is required for worlds first saved after the fix.

## Prevention
The store is the single source of truth for an item's **current** stats, and in the recipe→derivation model **matter** is the single source of **factory** stats. The invariant to keep: *at the moment an item enters a per-instance store, the store must be seeded from whatever the recipe's source of base traits is* — explicit traits if declared, otherwise the matter derivation, otherwise the existence baseline. Any reader that is "live stats first" will otherwise silently see a knife with no sharpness and degrade to "not capable", with no error to point at the missing writer step.

This is the same drift class as BUG-133: a shared contract ("the store holds an item's base traits") that a data migration implicitly moved, where only some parties were updated. The regression tests now pin both the happy path (the unseeded production equip flow surfaces `cut` in the capability cache *and* in the endpoint-shaped view) and the graceful-degradation invariant (a genuinely trait-**and**-matter-free item never surfaces `cut`) — the real knife can no longer pin "never invents", because it now legitimately carries derived sharpness.

## References
- Related bug (direct predecessor): [BUG-133](BUG-133-knife-cannot-be-equipped-massburden-contract-drift.md)
- Related bug: `wiki/bugfixWiki/high/BUG-096-knife-sharpness-drain-not-working.md`
- Related bug: `wiki/bugfixWiki/high/BUG-099-cut-action-damage-ignores-sharpness-drain.md`
- Related wiki: `wiki/basic_traits_and_stats_spec.md` (design D4/D6 — every stat has exactly one source: matter, form, or function)
- Related wiki: `wiki/subMDs/controllers/equipped_item_stats_controller.md`
- Related wiki: `wiki/subMDs/controllers/capability_controller.md`
- Related controller: `HoldingCostController`
- Related controller: `EquippedItemStatsController`
- Related controller: `ComponentCapabilityController`
- Related test: `test/contract/equippedKnifeCapability.contract.test.js`
