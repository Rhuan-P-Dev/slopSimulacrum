# BUG-133: Knife Cannot Be Equipped — massBurden Contract Drift Left Consumers Gating on the Removed itemDef.traits

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/js/InventoryManager.js`, `src/controllers/capabilities/componentCapabilityController.js`, `src/controllers/actions/RequirementResolver.js`

## Symptoms
The knife could not be equipped: the **Equip** button was never rendered for *any* item in the inventory overlay, so the equip flow was unreachable from the UI. On the server, even when an equipped item was present (e.g. via the equip pipeline, which was fully functional and covered by `test/contract/persistence.contract.test.js`), the capability scan never surfaced the `cut` capability for an equipped knife, and `RequirementResolver` could not resolve the equipped item for requirement checks.

## Root Cause
A **client/server contract drift** was introduced by the recipe-to-derivation data migration, which restructured a contract shared by both layers: it consolidated the per-item burden registry into a single model declaration and moved each item's base traits out of an explicit recipe field into the matter-derivation model. In effect the data moved, but the consumers that still looked in the old place now read "absent" where a value used to be.

Several consumers still indexed the *old* shape:

1. The client's equip affordance and its equipped list still keyed on the removed per-item declaration — and the equipped list on a field the server never sends — so the affordance never appeared and the entries collapsed.
2. The capability-discovery scan still required the removed explicit trait list, so post-migration items were silently skipped.
3. Requirement resolution did the same and returned no resolution.

The equip pipeline itself was sound: a field move is a breaking contract change, and only the writer was updated. The drift stayed invisible because each consumer treats "data absent" identically to "not equippable", so it degrades silently instead of erroring.

## Fix
Every consumer was re-aligned to the post-migration contract, so equipability and traits are now read from the new sources of truth instead of the removed fields:

- **Client equip affordance** — gated on the model's equipable-item declaration rather than the removed per-item key, and the burden display is rendered from the model's gate and carrying declarations (no hand-typed values).
- **Client equipped list** — keyed (and removed) by the typed equipped-ID the server emits, skipping malformed entries instead of collapsing them under a single key.
- **Server stat resolution** — an equipped item's stats now resolve with a fixed precedence: the item's current per-instance stats (wear accumulates in the item, so current state outranks factory values) → its static base trait declaration → a clean skip when neither exists. A capability is never invented; the relaxation degrades safely.

No data files were modified; the architecture is unchanged (only the consumer-side contract alignment).

## Prevention
When a data model shape changes (especially a migration that renames or re-structures a registry consumed across the client/server boundary), add or update a **contract test** that asserts the client and every server consumer agree on the shape. The new regression tests cover both halves:

- `test/unit/InventoryManager.client.test.js` — Equip button rendered for an `equipableItems` entry and *not* for a non-equipable item, data-driven `_formatHoldingCost`, and equipped-list keying by `eqId`.
- `test/contract/equippedKnifeCapability.contract.test.js` — the capability scan surfaces `cut` for an equipped knife (with derived sharpness) and never invents it for an unseeded item; `RequirementResolver` resolves the equipped item via both the equipped-id and host-component paths without a top-level `itemDef.traits`.

More generally: treat "a field moved / was removed" as a breaking contract change that must be swept across all consumers (client and server), not just the writer.

**Follow-up (tracked refactor, deferred to keep this fix surgical):** the staged "live per-instance stats → base traits → safe skip" resolution order is currently inlined at several call sites across the capability-discovery and requirement-resolution controllers — the very drift class that caused this bug. Consolidate it into a single shared resolver on the per-instance stats store, and route the capability controller's access to that store through a new public world-facade passthrough method (it currently reaches the sub-controller through a documented facade property). Update the composition-root dependency notes and the architecture map when done; the BUG-133 fallback contract tests are the acceptance net and must pass unchanged.
## References
- Related wiki: `wiki/subMDs/data/holding_cost.md`
- Related wiki: `wiki/subMDs/data/inventory_system.md`
- Related wiki: `wiki/subMDs/controllers/equipped_item_stats_controller.md`
- Related wiki: `wiki/basic_traits_and_stats_spec.md` (design D6 keeps the massBurden equip gate)
- Related bug: `wiki/bugfixWiki/high/BUG-093-equipped-item-stats-ignored-in-requirement-checks.md`
- Related bug: `wiki/bugfixWiki/high/BUG-097-cut-action-disappears-after-use.md`
- Related controller: `HoldingCostController`
- Related controller: `EquippedItemStatsController`
- Related controller: `ComponentCapabilityController`
- Related controller: `RequirementResolver`
