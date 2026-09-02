# 💥 Material Damage Split & Material Chunk Drops — Spec

> **Status:** agreed design for two data-driven features. **Why** of the design lives here; all **values** are data-driven and live in `data/*.json`. Names for channels live in [`shared/StatVocabulary.js`](shared/StatVocabulary.js:102) and typed-ID conventions in [`shared/IdPrefixes.js`](shared/IdPrefixes.js:27) — the data files must match them, never the other way around.
>
> **Feature 1 — Per-material damage types.** A new data file defines, per material, how the raw value of a channel-damage consequence is split across the six damage channels. The split is driven by the **attacking** component's material composition and applies to **all** channel-based damage actions — `droid punch`, `cut`, `shootT1` — through one shared code path.
>
> **Feature 2 — Material chunk drop on punch.** On every successful punch hit, the target loses existence (its remaining matter). Per material present in the target's composition, one **material chunk** ground item may drop, with probability and volume governed by a second new data file. Chunk items are **dynamically generated** — they have no entry in [`data/inventoryItems.json`](data/inventoryItems.json) — and integrate with the existing dropped-item/pickup flows.

---

## 1. Why both features now

The basic-traits model made existence a matter store and damage channel-aware, but two gaps remain:

- **The attacker's material is decorative in combat.** A punch carries a channel (`impact`) and a value, but *what is punching* plays no part. A wooden fist and an iron fist deal identical damage. With material identity already central to what a component *is*, combat should read the same way: a wooden fist blunts and shreds (impact mixed with cut and wear), an iron fist is pure impact.
- **Lost matter vanishes.** A punched component's existence drains, and the drained matter simply disappears. The world's theme is salvage: matter that leaves a component should leave a trace on the ground that other entities can find, pick up, and reuse. Punching is the deliberate, repeated, close-range act that makes "chips fly off" legible.

Both features are pure **data + thin read paths**: no new world state categories, no new stat vocabulary, no new client protocol. Everything new is either a registry read or a consequence handler in the existing pipeline.

---

## 2. Model

```mermaid
flowchart LR
    A[Punch consequence list in data/actions.json] --> B[damageComponent consequence]
    B --> C[raw value split across channels by attacker material blend]
    C --> D[per-channel existence loss via target resistances]
    D --> E[applied loss published into consequence context]
    E --> F[dropMaterialChunk consequence]
    F --> G[per-material drop roll and chunk volume]
    G --> H[ground chunk records written via existing dropped-item store]
    H --> I[pickup synthesizes the item definition - no registry entry]
```

Two one-way flows, both downstream of the existing consequence pipeline:

1. **Damage split** happens *inside* the channel-damage step: the raw value is divided across channels by the attacker's blended material split, each slice is converted to existence loss through the target's resistance to *that* channel, and the sum is applied as the existence delta.
2. **Chunk drop** happens *after* damage, as a separate consequence that only *consumes* the loss the damage step published. It never re-derives damage, never touches the break/removal pipeline, and never pushes state up to a sub-controller — it writes ground items through the same dropped-item store the break/spill flow already uses.

---

## 3. Design decisions

### D1 — Two new data files; the fixed minimum chunk volume lives in the drop-rates file

- `data/materialDamageTypes.json` — per material, the percentage of a consequence's raw value that goes to each damage channel.
- `data/materialDropRates.json` — per material, the punch drop probability and the fraction of lost matter that forms a chunk; plus one global scalar, the **fixed minimum chunk volume**.

**Why two files.** The damage split and the drop rates have different consumers (the damage handler vs. the chunk-drop handler), different cadence of tuning, and different shape. Keeping them separate means tuning punch physics never touches loot feel, and each file validates independently at boot.

**Why the minimum chunk volume is a data-file field, not a code constant.** It is a balance lever ("how small a chip is still worth picking up"), and the project rule is that balance lives in `data/*.json`. [`shared/Defaults.js`](shared/Defaults.js) is reserved for safety fallbacks (it is never a tuning knob), and [`src/utils/Constants.js`](src/utils/Constants.js) holds code-level named constants. The house precedent for a global scalar inside a data file is [`data/holdingCost.json`](data/holdingCost.json), which carries its `floor` scalar inside the `carryingCost` section. The drop-rates file follows the same multi-section shape (a global scalar plus a per-material section).

### D2 — Controller ownership: extend `MaterialController`; no new state controller

Both files are **material knowledge keyed by material name**, which is exactly the domain [`src/controllers/materials/MaterialController.js`](src/controllers/materials/MaterialController.js:24) already owns. It is the single reader of `data/materials.json` and `data/propertyTraitMapping.json`; it becomes the single reader of the two new files as well.

**Why not a new state controller.** The controller-patterns rule distinguishes state controllers (which own mutable world state) from data registries (static, loaded once). Neither new file holds state — they are static registries of the same kind MaterialController already guards. A second material-data controller would split material knowledge across two owners and force the damage and drop handlers to consult two sources for "what is this material". Extending the existing controller also inherits its invariants for free: loaded at the composition root, validated at construction with `TypeError` on malformed shape, defensive deep copies on every read.

**Wiring (one load, N readers — the existing pattern in [`src/composition/WorldComposition.js`](src/composition/WorldComposition.js:144)):** the composition root loads both files with `DataLoader.loadJsonSafe()` next to the other two material files and passes them to the `MaterialController` constructor. The composition root performs the boot-time cross-validation (§0.5 fail-fast pattern) that every material name in both files exists in `data/materials.json`.

### D3 — The damage split applies at the single channel-damage choke point

All three in-scope actions already converge on one place: [`DamageConsequenceHandler._handleChannelDamage`](src/controllers/consequences/DamageConsequenceHandler.js:110). Punch and cut dispatch `damageComponent` consequences directly; `shootT1` goes through `consumeItemAndDamage`, whose handler [`ConsumeItemHandler`](src/controllers/consequences/ConsumeItemHandler.js:35) delegates to the same `_handleDamageComponent`. The split is applied **once, inside that choke point**, before the target-type routing (equipped item / component / entity):

- The raw value is divided into per-channel slices by the attacker's blended split (D4).
- Each slice is converted to an existence loss with the existing formula `slice / (100 + target's resistance to that channel)` — so a wooden fist's cut slice is resisted by the target's `cut_resistance`, its impact slice by `impact_resistance`, independently.
- The losses are summed and applied as a single existence delta (one stat update, one listener notification).

**Why here and not per-action.** Applying the split per action would fork the damage semantics: the resistance interaction, the equipped-item routing, and the entity path would each need the split logic duplicated. The choke point is action-name agnostic by design (see [attack_system.md](wiki/subMDs/architecture/attack_system.md)) — any future channel-damage action gets material-aware splitting for free. The legacy trait/stat path (no `channel` in the consequence) is untouched, so back-compat actions behave exactly as today.

**Why sum-then-apply, not per-channel deltas.** Existence is one blended 0–1 store; applying the total as a single delta keeps the stat-change listener (and the break check at `EXISTENCE_GONE_AT = 0`) firing exactly once per hit, and keeps the "applied loss" figure the chunk drop needs unambiguous.

### D4 — Attacker material resolution: the object that is doing the punching

The handler resolves the attacking object from the consequence context, in this order:

1. `attackerComponentId` in the handler context (present on the multi-attacker path, where the dispatcher injects it per attacker).
2. The first component/equipped ID among the `fulfillingComponents` values (the single-attacker path — e.g. the fist component fulfilling `Physical.strength` for punch, or the equipped knife fulfilling `Physical.sharpness` for cut).

The resolved ID is then mapped to a material composition:

- **`comp-` ID** → the component's type → its recipe composition from the component registry (per-type static composition; there is no per-instance composition store, and none is needed — composition is part of the recipe).
- **`eq-` ID** (an equipped item, e.g. the knife in `cut`) → the *item's own* composition from its item definition. Semantically, the material doing the cutting is the blade, not the hand holding it. If the item's materials are unavailable, fall back to the host component's composition.
- **Unresolvable** (neither form, or missing) → no split: 100% of the value stays on the consequence's declared channel — exactly today's behavior.

**Why blend by composition fraction for multi-material attackers.** A `droidHand` (iron 0.7 + wood 0.3) is neither fully iron nor fully wood. The blended split is the fraction-weighted sum of each material's split — the same weighting rule [`MaterialController._blendProperties`](src/controllers/materials/MaterialController.js:198) uses to derive stats. One rule for "what does a composition do" keeps the model consistent across derivation and combat. The blend computation itself (`getBlendedDamageTypeSplit(materials, fallbackChannel)`) belongs in `MaterialController`, because it is pure material-data math; the damage handler keeps the damage mechanics (slice → resistance → loss).

### D5 — The damage consequence publishes the applied loss; the drop consequence only consumes it

On success, the channel-damage step writes a reserved entry into the consequence context's action params (shape: the target ID and the **applied** loss — the existence delta that actually left the target, clamped to what the target had). The dispatcher's existing propagation (`propagateParams: true` on the single-attacker path, see [`ConsequenceDispatcher._dispatchConsequences`](src/controllers/consequences/ConsequenceDispatcher.js:367)) carries it to later consequences in the same pipeline — the same mechanism `consumeItemAndDamage` already uses to hand `itemVolume` to the damage step.

**Why this and not recomputing in the drop handler.** The requirement is that dropped volume is tied to the damage *actually applied*. Recomputing would duplicate the split, the resistance formula, and the clamping — and would silently diverge if either side changes. Publishing makes the relationship structural: the drop handler's entire input is one published number plus the target's recipe. It also preserves the one-way data-flow rule — the drop is a consequence *of* the punch result, computed from the result, never feeding back.

**Why the applied (clamped) loss, not the computed loss.** If a punch overkills a nearly-gone component, the matter that left the component is what it had, not the theoretical loss. Chunks represent matter that actually became loose, so the volume derives from the clamped delta.

### D6 — Chunk drop is a new consequence type, declared on punch in data

A new consequence type, `dropMaterialChunk`, is added to the `droid punch` consequence list in [`data/actions.json`](data/actions.json:95) **after** `damageComponent`, with target `target` and no params (everything it needs arrives via context and world state). A new focused handler module, `src/controllers/consequences/MaterialChunkDropHandler.js` (a class with named dependencies, following the `DamageConsequenceHandler` precedent), is registered in the [`ConsequenceHandlers`](src/controllers/consequences/consequenceHandlers.js:96) handler map alongside the others.

**Why a consequence and not logic inside the damage handler.** Consequence lists in data are the project's answer to "what happens when an action succeeds" — declaring the drop on punch means *which actions drop chunks is a data decision* (today: punch only; `cut` and `shootT1` never drop, per scope). It keeps the damage handler responsible for exactly one thing, and it gives the drop its own result entry in the action outcome (auditable, testable, logged). **Why a handler module and not controller logic.** The consequences system is where action-result side effects live; a world-state controller writing ground items mid-action would invert the flow (controllers hold state; consequences act on it).

**Wiring:** `ConsequenceHandlers` gains one named dependency, `materialController` (one line at its construction in [`WorldComposition`](src/composition/WorldComposition.js:221), where `materialController` already exists one section earlier). The facade reference arrives post-construction via the existing `setWorldStateController` propagation. `DamageConsequenceHandler` likewise receives `materialController` in its controllers bag for the split lookups.

### D7 — Chunk volume contract

For a successful punch with applied loss `L` (0..1) against a target of recipe volume `V`:

- Per material `i` with recipe fraction `f_i`: the matter lost from that material is `lost_i = L × f_i × V`. (Existence is one blended ratio — there is no per-material matter store — so recipe fractions are the only faithful attribution of the lost matter to materials, mirroring how composition fractions already attribute *properties*.)
- If that material's drop roll succeeds (probability `dropRate_i`): the chunk volume is `max(minChunkVolume, chunkFraction_i × lost_i)`.

`chunkFraction_i` (0..1) is the share of a material's lost matter that remains recoverable as a chunk; the rest is dispersed (dust, wear) and never reappears — which is why chunks are smaller than the raw loss and why the same punch can still leave a *floor-sized* chip: `minChunkVolume` guarantees every successful roll produces a physically meaningful, pickable token instead of a numerical speck. All five quantities (two per material, one global) are balance levers in `data/materialDropRates.json`; none of them lives in code.

### D8 — The chunk is a dynamically generated item with no registry entry

- **Type:** `chunk_<materialName>` (e.g. `chunk_iron`), built from a named prefix constant (`CHUNK_ITEM_TYPE_PREFIX`) in [`src/utils/Constants.js`](src/utils/Constants.js). The material name is embedded in the type, so **any** consumer can recover the material from the type alone — the type is self-describing.
- **ID:** `item-` typed ID from the existing generator ([`generateItemId`](src/utils/idGenerator.js:32)) — the same family as every other item.
- **Ground record:** written through the existing [`writeDroppedItem`](src/controllers/consequences/DropItemHandler.js:35) helper — the same function the break/spill flow uses — positioned by a disk sample around the target entity's position in the target's room (the spill flow's own `sampleDiskPoint` approach), owned by the target entity. Dropped records are already self-describing (`name`, `description`, `volume`, `itemType`), so the world map and pickup overlay render chunks with **zero client changes**.
- **Name/description:** derived from the material name (e.g. "Iron chunk"); no per-instance free text.

**Why a naming convention plus synthesis instead of a registry entry.** An explicit `inventoryItems.json` entry would require one entry per material, would carry a *static* volume (chunks are volume-dynamic), and would reify dynamic loot as data. The alternative — the convention above — costs nothing at boot and makes "dynamically generated" structural: a chunk's only variable (volume) lives on the ground record, and its only identity (material) lives in the type string.

**Definition synthesis at the four registry-lookup sites.** Today, an unknown `itemType` is rejected wherever an item definition is fetched. Each such site gains one rule: *if the type is a chunk type, synthesize the definition* (name/volume from the ground record or the item instance, materials as 100% of the recovered material, traits derived through the existing `MaterialController.derive` pipeline — consistent with "items are small components" and the existing `_mergeItemTraits` precedent). The four sites:

1. [`PickUpItemHandler`](src/controllers/consequences/PickUpItemHandler.js:127) — the registry lookup that currently fails for unknown types. It also validates that the recovered material exists in the materials registry (defensive refusal with a clear message; drops only ever originate from validated recipes, so this should never fire in play).
2. [`InventoryManager.addItem`](src/utils/InventoryManager.js:176) — accepts an explicit definition override in its options so the synthesized definition bypasses the registry; its existing `_mergeItemTraits` derives the chunk's traits from the synthesized 100%-single-material composition. The facade passthrough `WorldStateController.addItemToEntity` carries the options through (public API, minimal extension).
3. [`DropItemHandler`](src/controllers/consequences/DropItemHandler.js:154) — the definition fallback for re-drops: a chunk re-dropped from inventory keeps its dynamic volume from the item instance instead of silently falling back to the default.
4. [`WorldStateController.getItemStats`](src/controllers/WorldStateController.js:2590) — the same registry→synthesis resolution so chunk items in an inventory report material-derived stats.

**Persistence:** chunk ground records and chunk inventory instances carry no state beyond what the existing item/dropped-item contracts already serialize (id, type, name, volume, room/position, traits). Save/load round-trips with no schema change.

### D9 — Fallbacks and load-time behavior

**Load (fail-fast at boot, per project rules §5–6).** Both files are loaded with `DataLoader.loadJsonSafe()` at the composition root and validated in the `MaterialController` constructor following the existing `_validateMaterialsRegistry` / `_validateMappingRegistry` pattern: structural malformation (wrong container type, unknown channel name, non-numeric or negative percentage, `dropRate`/`chunkFraction` outside 0..1, `minChunkVolume` present but not a positive number, material key not in `data/materials.json`) throws `TypeError` with a specific message — boot failure, exactly like the existing material validation.

**The two files distinguish "absent" from "malformed".** An empty or missing file means the *feature is off*, not that the world is broken — deleting a balance file must never crash the game:

| Situation | Behavior |
|---|---|
| File missing/empty | Feature disabled: no split (100% declared channel), no drops. `Logger.warn` at boot. |
| File present but structurally malformed | `TypeError` at construction (boot failure). |
| Percentages for a material don't sum to 100 | **Normalized** at load (proportional rescale) + `Logger.warn`. This is tuning drift, not malformed shape — the shape is still valid, so rejecting it would make a balance tweak a crash. |
| Attacker material missing from the damage file | 100% to the consequence's declared channel (today's behavior — the safe direction: the file's absence exactly reproduces current combat). |
| Target material missing from the drop file | No drop for that material (equivalent to rate 0). |
| Attacker unresolvable (no component/equipped ID in context) | No split — declared channel only, today's behavior. |
| Chunk pickup with a material absent from the materials registry | Pickup refused with a clear message (defensive; unreachable in play). |

**Why normalize at load rather than reject.** The split percentages are a tuning surface; designers will write 90s and 110s. Normalizing keeps the invariant (the raw value is fully allocated across channels) without punishing drift, and the warn makes the drift visible.

### D10 — Interplay with the break/removal flow: a broken target drops nothing

A punch that empties a component's existence crosses `EXISTENCE_GONE_AT = 0`, which the existing stat-change listener turns into a `component:broke` event and a synchronous `removeBrokenComponent` cascade (spill → cascade dependents → removal → cleanup) — all *inside* the damage consequence, before the drop consequence runs. When the drop handler then executes, the target component is gone from world state.

**Decision: the drop handler treats a vanished target as "zero drops, success".** Rationale:

- The break/spill flow already owns *total* loss of a component (its contents spill as items; the matter itself is consumed by the removal). Having the drop handler also emit chunks for a fully consumed component would double-represent the same matter.
- The decision falls out of the existing machinery with no special case beyond "target missing → nothing to drop from": the handler reads the target's recipe and position from world state; if the component is gone, there is nothing to read. No interaction with the re-entrancy counter, no re-entry into the removal pipeline, one-way flow preserved.
- Chunks represent *partial* loss on a component that still exists — the repeated-punch chip-off loop — which is exactly the gameplay the feature targets.

The drop path never triggers, delays, or observes the break flow; the break flow never knows chunks exist. They share only the ground-item store.

### D11 — Multi-attacker punches drop nothing (consistent with today's zero damage)

On the multi-attacker path ([`executeMultiAttacker`](src/controllers/consequences/ConsequenceDispatcher.js:102)), the dispatcher (a) passes unknown consequence types through per attacker unchanged — so `dropMaterialChunk` *does* run, once per attacker — and (b) never propagates handler-modified params (`propagateParams: false`), so no applied loss is published. The drop handler therefore sees no published loss and drops nothing, per-attacker.

**Why that is correct, not a gap.** That same path's per-attacker damage value is currently negated by construction (the legacy `_buildPerAttackerConsequences` value rewrite, [`ConsequenceDispatcher`](src/controllers/consequences/ConsequenceDispatcher.js:493)), so multi-attacker punches apply zero damage today; dropping nothing is the *consistent* reading of "volume tied to damage actually applied". Fixing the multi-attacker value semantics (and enabling propagation there) is a separate task — see Open Questions.

### D12 — Testing strategy: contract tests prove the pipeline, unit tests prove the math

Contract tests under `test/contract/` (same style as [`triggerComponentBroke.contract.test.js`](test/contract/triggerComponentBroke.contract.test.js): `buildWorldState` with the tick system not started, spawn, act through the real pipeline, assert side effects) cover the *integration claims*; unit tests cover the *formula and fallback claims* with stubs. The initial data is deliberately chosen so contract tests are deterministic without stubbing `Math.random` (the iron drop rate is 1.0).

---

## 4. Data contracts (field-level)

### `data/materialDamageTypes.json`

Top level: object. Keys = material names (must exist in [`data/materials.json`](data/materials.json)). Value per material: object mapping damage-channel names (keys of `DAMAGE_CHANNELS` in [`shared/StatVocabulary.js`](shared/StatVocabulary.js:102)) to percentages (numbers ≥ 0; should sum to 100 — normalized + warned if not). A material's entry declares how a raw value dealt *by that material* is distributed across channels.

```json
{
  "wood": { "impact": 50, "cut": 25, "wear": 25 },
  "iron": { "impact": 100 }
}
```

Proposed initial balance (tunable, wood = blunt+shredding, iron = pure impact — today's behavior).

### `data/materialDropRates.json`

Top level: object with two sections (same multi-section precedent as `data/holdingCost.json`):

- `minChunkVolume` — number > 0. Fixed floor for any dropped chunk volume.
- `materials` — object; keys = material names (must exist in `data/materials.json`); value per material:
  - `dropRate` — number in [0, 1]. Probability that this material drops a chunk per successful punch hit.
  - `chunkFraction` — number in [0, 1]. Share of the material's lost matter that forms the chunk (the rest disperses).

```json
{
  "minChunkVolume": 0.05,
  "materials": {
    "iron": { "dropRate": 1.0, "chunkFraction": 0.3 },
    "wood": { "dropRate": 0.25, "chunkFraction": 0.5 }
  }
}
```

Proposed initial balance (iron always drops — makes contract tests deterministic; wood is a 25% chip).

### Published-loss context entry (internal contract)

The channel-damage step publishes, into the consequence context's action params under a reserved key (proposed name: `lastChannelLoss`): the target ID and the applied loss (0..1, clamped to the target's prior existence). The drop consequence reads it; it is not part of any client-facing payload.

### Chunk volume contract

`lost_i = appliedLoss × fraction_i × recipeVolume` · `chunkVolume_i = max(minChunkVolume, chunkFraction_i × lost_i)`. All inputs are data or world state; no constants in code.

---

## 5. Integration points

### Feature 1 — per-material damage types

| File / area | Change |
|---|---|
| [`src/composition/WorldComposition.js`](src/composition/WorldComposition.js:144) | Load `data/materialDamageTypes.json` via `DataLoader.loadJsonSafe` next to the other material files; pass to the `MaterialController` constructor; extend the §0.5 boot validation (material keys ⊆ materials registry). |
| [`src/controllers/materials/MaterialController.js`](src/controllers/materials/MaterialController.js:24) | Two new constructor registry parameters; `_validateMaterialDamageTypes()` (TypeError, specific messages; empty = feature off + warn; non-100 sums normalized + warn); public read methods (defensive deep copies): `getDamageTypeSplit(materialName)`, `getBlendedDamageTypeSplit(materials, fallbackChannel)` (fraction-weighted; unknown material → 100% fallback channel). |
| [`src/controllers/consequences/DamageConsequenceHandler.js`](src/controllers/consequences/DamageConsequenceHandler.js:110) | `_handleChannelDamage` (and the entity path `_damageEntityComponentsByChannel`): resolve attacker (context `attackerComponentId` → `fulfillingComponents` comp/eq IDs; `eq-` → item-definition materials, fallback host component; `comp-` → type recipe composition via [`getComponentMaterialsByType`](src/controllers/core/componentController.js:293)); blended split from `MaterialController`; slice value per channel; per-channel `_computeChannelLoss` with each channel's own resistance; sum applied as one existence delta; publish applied loss into context (D5). |
| [`src/controllers/consequences/consequenceHandlers.js`](src/controllers/consequences/consequenceHandlers.js:49) | `DamageConsequenceHandler` constructed with `materialController` in its controllers bag; `ConsequenceHandlers` constructor gains the `materialController` named dependency (fed at its single construction site in WorldComposition). |
| [`data/actions.json`](data/actions.json) | **No change for Feature 1** — the split is inside the existing `damageComponent` consequences of punch/cut/shootT1. |

### Feature 2 — material chunk drop on punch

| File / area | Change |
|---|---|
| `data/materialDropRates.json` | New file (contract above). |
| [`src/composition/WorldComposition.js`](src/composition/WorldComposition.js:221) | Load the file; pass to `MaterialController` (with `MaterialController` gaining `getDropRate(materialName)` and `getMinChunkVolume()`); pass `materialController` into the `ConsequenceHandlers` construction. |
| `src/controllers/consequences/MaterialChunkDropHandler.js` | **New** focused handler (class, named deps `{ worldStateController, materialController }`; facade arrives via the existing post-construction propagation). Behavior: read published loss (missing/≤0/target-mismatch → success, zero drops) → resolve target component (vanished/equipped/entity → success, zero drops) → per-material recipe fractions + drop-rate lookups → roll + volume per D7 → write one ground record per successful roll via [`writeDroppedItem`](src/controllers/consequences/DropItemHandler.js:35) (position = disk sample around the target entity's position in its room, the spill flow's own approach; batched into one `setDroppedItems` write per punch). |
| [`src/controllers/consequences/consequenceHandlers.js`](src/controllers/consequences/consequenceHandlers.js:96) | Register `dropMaterialChunk` in the handler map; construct the new handler alongside the others. |
| [`data/actions.json`](data/actions.json:95) | `'droid punch'` consequences: add `{ "type": "dropMaterialChunk", "target": "target" }` after `damageComponent`. (Scope: punch only — `cut`/`shootT1` unchanged.) |
| [`src/controllers/consequences/PickUpItemHandler.js`](src/controllers/consequences/PickUpItemHandler.js:127) | Chunk-type synthesis at the registry lookup (D8 site 1): definition from the ground record (name, dynamic volume) + material recovered from the type; material-exists guard. |
| [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js:176) | `addItem` accepts an explicit definition override in options (registry bypass; traits via existing `_mergeItemTraits` from the synthesized 100%-single-material composition) (D8 site 2). |
| [`src/controllers/WorldStateController.js`](src/controllers/WorldStateController.js:1666) | `addItemToEntity` carries the options through to `InventoryManager.addItem`; `getItemStats` resolves chunk definitions via the same synthesis (D8 site 4). |
| [`src/controllers/consequences/DropItemHandler.js`](src/controllers/consequences/DropItemHandler.js:154) | Re-drop: for chunk types, prefer the item instance's own name/volume over the empty registry fallback (D8 site 3). |
| [`src/utils/Constants.js`](src/utils/Constants.js) | `CHUNK_ITEM_TYPE_PREFIX` named constant; small shared helper for "is this a chunk type / recover its material" (or a private pair in the consequences folder if a second consumer doesn't materialize — decide at implementation, keep it out of the client). |
| Client ([`public/js/WorldMapView.js`](public/js/WorldMapView.js), pickup overlay) | **No change** — ground records are self-describing; chunk names/volumes render as-is. Any client-side item-definition lookup for a chunk type must degrade to record fields (verify, no protocol change). |

---

## 6. Edge cases (consolidated)

- **Multi-material target** (e.g. a `droidHand` target, iron 0.7 + wood 0.3): one independent roll per material; at most one chunk per material per punch; lost matter attributed by fractions.
- **Multi-material attacker** (e.g. a `droidHand` punching): fraction-weighted blended split (D4).
- **Punch that breaks the target:** break/removal cascade runs inside the damage consequence; the drop consequence finds no target → zero drops; the spill flow (which spills *contents*, not matter) is untouched and orthogonal (D10).
- **Multi-attacker punch:** drop consequence runs per attacker but sees no published loss → zero drops, consistent with that path's current zero damage (D11).
- **Materials with no entry in either file:** declared-channel damage, no drops (D9).
- **Micro-loss punches** (tiny applied loss): the `minChunkVolume` floor makes any successful roll produce a floor-sized chip; a roll miss still drops nothing.
- **Chunk re-dropped and re-picked:** volume/name survive the round trip because the ground record and the inventory instance are self-describing and the re-drop site uses the instance (D8 site 3).
- **Save/load:** no new state categories; chunk records and instances serialize under the existing contracts (D8).
- **Deleting a data file at runtime is not a scenario** (files are loaded at boot), but deleting one *before* boot degrades to legacy behavior with a warn — never a crash (D9).

---

## 7. Test plan

### Contract tests — `test/contract/`

**`materialDamageSplit.contract.test.js`**

1. *Split applies to punch:* spawn a droid, punch a single-material iron target (e.g. `centralBall`) with an iron fist → existence loss equals the legacy single-channel formula exactly (iron's split is 100% impact); then punch with a multi-material fist (e.g. `droidHand`) → loss equals the per-channel sum computed from the data files (the test reads the same data files and asserts the *formula*, not hard-coded balance).
2. *Split applies to cut:* equipped multi-material knife cutting a target → loss includes the non-cut channels of the knife's blended split, resisted by the target's respective resistances.
3. *Split applies to shootT1:* fire the T1 (ammo volume as value) → same per-channel formula through the `consumeItemAndDamage` delegation path.
4. *Fallback:* an attacker whose materials are all absent from `data/materialDamageTypes.json` (test fixture: temporarily load a registry without that material, or point at a single-material attacker with an empty damage file) → behavior identical to today's single-channel damage.
5. *Regression:* with an empty damage file, punch/cut/shootT1 losses are bit-identical to pre-feature values (the safe-direction guarantee, D9).

**`materialChunkDrop.contract.test.js`**

1. *Drop on hit:* punch an iron target (iron `dropRate` 1.0) with non-lethal strength → exactly one ground item with type `chunk_iron` in the target's room (`getDroppedItems`), `item-`-prefixed item ID, chunk name, volume equal to the D7 formula evaluated from world state + data files.
2. *Floor:* punch with minimal strength so `chunkFraction × lost < minChunkVolume` → chunk volume equals `minChunkVolume`.
3. *Per-material independence:* punch a multi-material target → at most one `chunk_<material>` per material per punch; iron chunk present (rate 1.0), wood chunk present iff the roll hits (wood 0.25 — assert the upper bound, not the exact roll).
4. *No drop without damage:* the multi-attacker path (or a punch whose value resolves to 0) → no chunk records.
5. *Broken target:* punch with strength enough to empty existence → `component:broke` event recorded, component removed, **no** chunk records, spill flow behavior unchanged (no double-spill of contents).
6. *Dynamic pickup:* droid adjacent to a dropped `chunk_iron` → `pickUpItem` action → item in inventory with the correct dynamic volume, material-derived traits (iron 1.0 composition), and `'chunk_iron'` **not** present in `data/inventoryItems.json` (assert the registry is untouched).
7. *Re-drop:* `dropItem` action on the inventoried chunk → new ground record with the same name/volume; a second pickup works.
8. *Persistence:* serialize → restore → the chunk ground record (and, in a second scenario, the inventoried chunk) round-trips intact.

### Unit tests — `test/unit/`

- **`MaterialController` (new coverage):** both new validators — `TypeError` on wrong container, unknown channel name, negative/non-numeric percentage, `dropRate`/`chunkFraction` out of range, `minChunkVolume` present-but-invalid, material key absent from the materials registry; empty file → feature-off without throwing; non-100 sums → normalized + warn; `getBlendedDamageTypeSplit` weighted math (multi-material, unknown material → fallback channel, empty composition → 100% fallback); `getDropRate` null on missing material; defensive-copy guarantee (mutating a returned object never touches the registry).
- **`DamageConsequenceHandler`:** per-channel slicing with per-channel resistance (stubbed controllers); attacker resolution matrix (`comp-`, `eq-` with item materials, `eq-` falling back to host, unresolvable → no split); applied-loss publication shape and clamping; entity-path aggregation; legacy trait/stat path untouched.
- **`MaterialChunkDropHandler`:** roll boundaries with stubbed `Math.random` (0 / 0.5 / 1); volume formula including the floor; per-material independence; vanished target / entity / equipped target / missing published loss → success with zero drops; batched single `setDroppedItems` write.
- **Chunk type helper:** prefix detection + material recovery round trip.

---

## 8. Post-implementation documentation

- [`wiki/map.md`](wiki/map.md): add both data files to the data-files table; add dependency-graph edges — `WorldComposition → MaterialController` (four registries), `ConsequenceHandlers → MaterialChunkDropHandler`, `DamageConsequenceHandler ← materialController`.
- [`wiki/CORE.md`](wiki/CORE.md): link the new sub-documentation.
- **New** `wiki/subMDs/data/material_damage_and_drop.md`: the why of both features, the dynamic-item precedent (an item definition is no longer exclusively a registry entry — self-describing ground records plus a recoverable type), and the data contracts.
- Updates: [`materials.md`](wiki/subMDs/data/materials.md) (channels are now data-driven per attacker material; Phase-2 note), [`attack_system.md`](wiki/subMDs/architecture/attack_system.md) (the split at the choke point), [`inventory_system.md`](wiki/subMDs/data/inventory_system.md) (dynamic chunk items; the registry is no longer the only definition source), [`consequence_handler_architecture.md`](wiki/subMDs/controllers/consequence_handler_architecture.md) (handler table: `dropMaterialChunk` + the damage handler's material dependency).

---

## 9. Open questions for the user

1. **Multi-attacker zero-damage quirk.** The multi-attacker path's per-attacker damage value is negated by the legacy value rewrite, so those punches apply zero damage today; chunk drops are consistently absent there (D11). Confirm fixing that value (and enabling param propagation on that path) is a *separate* task, out of scope here.
2. **Broken target drops nothing** (D10): the break/spill flow owns total loss; a lethal punch emits no chunks. Confirm, or do you want chunks for the final full-matter loss too (would require a deliberate hand-off into the removal flow)?
3. **Punch-only drops** (scope): `cut` and `shootT1` never drop chunks because the consequence is declared only on punch in data. Confirm this matches the intent.
4. **Initial balance values** (wood 50/25/25 impact/cut/wear; iron 100 impact; drop rates 1.0/0.25; chunk fractions 0.3/0.5; `minChunkVolume` 0.05) are proposals encoded in the data contract — they are tunable without code changes.
5. **Chunk type naming** `chunk_<material>` — confirm the prefix convention (it is the load-bearing part of the dynamic-item design, D8).
