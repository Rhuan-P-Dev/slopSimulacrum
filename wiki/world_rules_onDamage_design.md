# Design: `onDamage` World-Event Rule (5% `host_material` chip)

**Status:** Design only (no code in this document). Supersedes nothing; extends the
torn-material rule layer ([`wiki/subMDs/data/world_rules.md`](subMDs/data/world_rules.md))
and the chunk-drop system ([`wiki/subMDs/data/material_damage_and_drop.md`](subMDs/data/material_damage_and_drop.md),
spec [`wiki/material_damage_and_drop_spec.md`](material_damage_and_drop_spec.md)).

**Target expression (user-confirmed, fixed requirement):**
`data/world_rules.json` must support:
`"onDamage": [ { "drop": "host_material", "percentage": 0.05 } ]`

## 0. Fixed requirements (from the user; do not re-litigate)

| # | Requirement |
|---|-------------|
| R1 | `onDamage` fires on **every** damage application to a component — any source that decreases a component stat: channel damage (punch/cut/shoot), IC ticks (corrosion etc.), direct stat deltas (holding cost, stat effects). |
| R2 | Each array entry is rolled **independently** per damage event (Bernoulli trial, `p = percentage`, range `0..1`). |
| R3 | On success: drop a **dynamically-generated chunk item** of the damaged component's material — the same self-describing `chunk_<material>` items the material chunk-drop system produces (no item-registry entry). Multi-material compositions use the material with the **largest composition fraction**. |
| R4 | The roll is **additive** on top of the existing per-material chunk drops driven by `data/materialDropRates.json` (both may fire on the same damage event; the legacy roll must not be altered, suppressed, or re-used). |
| R5 | `damageTornMaterial` keeps working **unchanged** (bit-for-bit). |
| R6 | Degradation contract: missing/empty/malformed `data/world_rules.json` → all world rules off (legacy behavior, never crashes). A malformed individual `onDamage` entry → skipped with a warning, not fatal. |

## 1. Current-state summary (verified in this worktree)

### 1.1 World rules layer
- [`WorldRulesController`](src/controllers/worldRules/WorldRulesController.js) is a Layer-0 data owner.
  It is constructed by the composition root with the parsed file content
  ([`WorldComposition.js`](src/composition/WorldComposition.js) loads
  `data/world_rules.json` via `DataLoader.loadJsonSafe` (line ~162) and constructs the
  controller at line ~163). It does no file I/O itself.
- The **only** shipped rule is `damageTornMaterial` (`data/world_rules.json` line 3, `percent: 10`).
- Validation is **degenerate by design** (deliberate divergence from the material files'
  boot-fail `TypeError` contract, documented in the controller header):
  - `null`/non-object top level → all rules off, one `Logger.warn`, **no throw**
    (method [`_validateWorldRules`](src/controllers/worldRules/WorldRulesController.js:77)).
  - Unknown rule key → warn + ignore (forward compatibility).
  - Known key with malformed config (`percent` missing/non-numeric/out of `[0,100]`,
    `enabled` non-boolean) → that rule off with a warn; other rules unaffected.
- Public readers (all null-tolerant, defensive copies):
  [`getRule(key)`](src/controllers/worldRules/WorldRulesController.js:204),
  [`isRuleActive(key)`](src/controllers/worldRules/WorldRulesController.js:215),
  [`getActiveRules()`](src/controllers/worldRules/WorldRulesController.js:227),
  [`getDamageTornMaterialPercent()`](src/controllers/worldRules/WorldRulesController.js:243) (returns `0` when off).
- The facade exposes [`getWorldRules()`](src/controllers/WorldStateController.js:2389) (thin passthrough to
  `getActiveRules()`; inspection only — deliberately **not** in the broadcast aggregation).
- `_logSummary()` (line 188) emits
  `[WorldRulesController] initialized: X/Y rule(s) active (...)`.
  **Constraint:** the existing unit test
  [`test/unit/WorldRulesController.test.js`](test/unit/WorldRulesController.test.js)
  asserts this line via an unanchored substring regex (`/0\/1 rule\(s\) active \(none\)/`)
  — any extension of the summary must keep that prefix verbatim and only append after it.

### 1.2 Where damage is actually applied
- **Single choke point.** Every component stat mutation goes through
  [`ComponentController.updateComponentStat`](src/controllers/core/componentController.js:114)
  (semantic set; writes at line 123, notifies at line 124),
  [`updateComponentStatDelta`](src/controllers/core/componentController.js:136)
  (guarded write at lines 139–143, notifies at line 145), or
  [`updateComponentStatRelative`](src/controllers/core/componentController.js:165)
  (which delegates to `updateComponentStatDelta`). All three funnel into
  [`_notifyStatChangeListeners`](src/controllers/core/componentController.js:54)
  (subscriber list `_statChangeListeners`, registered by the facade at
  [`WorldStateController` constructor](src/controllers/WorldStateController.js:198)).
- Damage sources and how they reach the choke point:
  - **Channel damage (punch/cut/shoot):** [`DamageConsequenceHandler`](src/controllers/consequences/DamageConsequenceHandler.js)
    computes per-channel losses, clamps applied loss
    (`appliedLoss = min(max(0, old), max(0, old − loss))` in
    `_applyChannelDamageToComponent`), applies it with `updateComponentStatDelta(existence, −appliedLoss)`,
    and **publishes** the loss into the dispatch context under
    `PUBLISHED_CHANNEL_LOSS_KEY` (`src/utils/Constants.js:141`) so the chunk-drop
    consequence can act on the *applied* (clamped) loss, not the computed one.
  - **IC ticks / stat effects / holding cost:** call the same three update methods
    directly (e.g. corrosion `emitChannelDamage` organ in
    [`data/internalComponents.json`](data/internalComponents.json:64) → damage → `updateComponentStatDelta`).
- **Consequence flow:** [`ConsequenceDispatcher`](src/controllers/consequences/ConsequenceDispatcher.js)
  runs `applyDamage` → `dropMaterialChunk` for punches (consequence order in the action
  definitions). The chunk handler is **not** a choke point: it only sees punches (and
  cut/shoot via their own consequence lists) — never IC-tick or direct-delta damage.
  This is why R1 ("every source") cannot be satisfied at the consequence layer.

### 1.3 How chunk items are generated and placed
[`MaterialChunkDropHandler`](src/controllers/consequences/MaterialChunkDropHandler.js)
(feature 2 + the torn stream, WR-2), `_handleDropMaterialChunk` (line 64):
1. Reads the published loss from context (lines 74–80) — its **only** damage input.
2. Resolves the target component (`world.getComponent(targetId)`, line 90) and entity
   (`world.getEntity(comp.entityId)`, line 96) — both null-tolerant (vanished target →
   zero drops, the D10 contract of the spec).
3. Reads the recipe composition (`world.componentController.getComponentMaterialsByType()`,
   line 102) and recipe volume (`getDefinitionVolume(world.componentController.getComponentDefinition(type))`,
   line 107, from [`src/utils/definitionVolume.js`](src/utils/definitionVolume.js)).
4. **Chunk stream** (lines 126–156): per material — independent `Math.random() < dropRate`
   roll (line 139), D7 volume
   `max(minChunkVolume, chunkFraction × appliedLoss × fraction × recipeVolume)` (lines 141–142),
   item type `CHUNK_ITEM_TYPE_PREFIX + material` (`chunk_iron`, constant at
   `src/utils/Constants.js:107`), disk-sampled position
   (`sampleDiskPoint(cx, cy, DEFAULT_TRIGGER_RADIUS)`, [`src/utils/DiskSampler.js`](src/utils/DiskSampler.js),
   line 145), a self-describing `itemDef` (lines 148–152), written with the shared
   [`writeDroppedItem`](src/controllers/consequences/DropItemHandler.js) helper into a
   local batch object (narrow-deps pattern, lines 118–124) — **one batched
   `world.setDroppedItems(batch)` write** (line 202) per punch (D6).
5. **Torn stream** (lines 158–197): deterministic, gated by
   `worldRulesController.getDamageTornMaterialPercent()` (line 168);
   `tornVolume = (percent/100) × appliedLoss × fraction × recipeVolume` (line 176),
   same min-chunk floor (line 181), same item type/placement mechanics (lines 183–193).
6. `minChunkVolume` and per-material `dropRate`/`chunkFraction` come from
   [`MaterialController`](src/controllers/materials/MaterialController.js)
   (owner of `data/materialDropRates.json`): `getDropRate(material)`, `getMinChunkVolume()`.

**Key fact:** chunk items are **pure world-state ground records** (no item-registry
entry, self-describing type, D8) — creating "a chunk item" is just `writeDroppedItem` +
a disk sample + an `itemDef`. There is no separate item-spawn path to integrate with.

## 2. Proposed data schema

### 2.1 File shape — `onDamage` joins the existing `rules` section

The confirmed expression is added as a **sibling key of `damageTornMaterial`** inside
the existing `rules` object (the most literal reading of the confirmed expression;
"keep existing keys intact" holds trivially). Exact shipped content of
[`data/world_rules.json`](data/world_rules.json):

```json
{
  "_comment": "World-level rules. Each key under rules is a stable string key mapping to a small config that governs a cross-cutting behavior; see the world-rules wiki page for the semantics and degradation contract of each rule.",
  "rules": {
    "damageTornMaterial": {
      "percent": 10
    },
    "onDamage": [
      { "drop": "host_material", "percentage": 0.05 }
    ]
  }
}
```

### 2.2 Schema of the event section

| Element | Kind | Meaning |
|---|---|---|
| `onDamage` | array of entries (a key inside `rules`) | The damage-event rule table. |
| `onDamage[i].drop` | string token, required | What to drop on success. Allowed today: `host_material`. Unknown extra fields on an entry are **ignored** (forward compatibility). |
| `onDamage[i].percentage` | number, required, `0..1` | Bernoulli probability of the per-entry trial, per damage event. (`0` = never; `1` = always. Note the deliberate scale difference vs `damageTornMaterial.percent` which is a 0–100 percentage — `onDamage.percentage` is a raw probability because the entry is a roll, not a matter share.) |

**Token registry (extensibility):** tokens are recognized by a named constant set in the
controller, `KNOWN_DROP_TOKENS = new Set(['host_material'])` — a future token (e.g.
`host_material_primary`, `fixed_item`) is added by adding one entry to the set plus one
resolution branch in the consumer. Unknown tokens at file level → entry skipped with a
warn (see §5); unknown tokens at runtime are impossible (validated at load) and the
consumer still guards with a default-branch warn (defense in depth).

**Rejected alternative (recorded for the review):** a separate top-level `events`
section (`{ "rules": {...}, "events": { "onDamage": [...] } }`). It is a cleaner type
separation (scalar-config rules vs event tables) but adds a second top-level structural
concept to a file the wiki defines as "stable string key → small config object", and the
per-key validation loop already isolates shape differences. The nested-in-`rules` form
also degrades identically for version skew: an **old** server reading a file with
`onDamage` hits the existing unknown-key branch (warn + ignore); a **new** server reading
an old file simply has no event entries.

### 2.3 Runtime data contract (what the consumer sees)

`getOnDamageRules()` returns a **defensive deep copy** of the validated, active entries:
`Array<{ drop: string, percentage: number }>` — `[]` when the file is missing/degraded,
`onDamage` is absent/malformed/empty, or the controller is unwired. The stored shape is
identical to the file shape (normalized to the two known fields only).

## 3. Runtime design

### 3.1 Dispatch point — the stat choke point, new damage-listener list

The event fires at the **only** place a component stat can decrease:
[`ComponentController`](src/controllers/core/componentController.js). Additions
(mirroring the existing `_statChangeListeners` observer mechanism, lines 20–62):

1. `this._damageListeners = []` (constructor, next to line 21).
2. `registerDamageListener(listener)` / `unregisterDamageListener(listener)` —
   same shape as [`registerStatChangeListener`](src/controllers/core/componentController.js:28).
3. `_notifyDamageListeners(componentId, traitId, statName, oldValue, newValue)` —
   same loop + per-listener `try/catch` + `Logger.error` as
   [`_notifyStatChangeListeners`](src/controllers/core/componentController.js:54).

Hook call sites (both strict-decrease only, so heals/sets never fire the event):

| Method | Exact insertion | Condition |
|---|---|---|
| [`updateComponentStatDelta`](src/controllers/core/componentController.js:136) | after the `setStats` write (line 143), **before** `_notifyStatChangeListeners` (line 145) | `delta < 0` (a delta on a stat that exists; the guard at line 139 already guarantees numeric old value) |
| [`updateComponentStat`](src/controllers/core/componentController.js:114) | after the `setStats` write (line 123), **before** `_notifyStatChangeListeners` (line 124) | both `oldValue` and `value` are numbers and `value < oldValue` |

`updateComponentStatRelative` needs **no** change — it delegates to `updateComponentStatDelta`.

**Why before the stat-change notification (ordering):** the facade's stat-change
listener is what drives the break cascade
([`WorldStateController` lines 198–244](src/controllers/WorldStateController.js:198) →
`TriggerController.onComponentBrokeCheck` → `component:broke` → component removal + spill,
all synchronously inside that notification). Firing the damage listeners **first** means
the damaged component is still resolvable when the consumer runs, and the consumer's own
total-loss skip (§3.4) decides lethal hits deterministically — instead of depending on
listener registration order vs the removal cascade. The per-listener `try/catch` also
guarantees a consumer failure can never delay or break the capability/break/broadcast
pipeline.

### 3.2 The event context

The listener signature mirrors the stat-change one (no object allocation, symmetric with
the existing mechanism):

```
(componentId, traitId, statName, oldValue, newValue)
```

- `componentId` — the damaged component instance id (the identifier the consumer needs).
- `traitId` / `statName` — which stat decreased (`Physical.existence` for all physical
  damage; `Movement.move`, `Physical.strength`, ... for non-existence decrements).
- `oldValue` / `newValue` — the stat before/after (both numeric at the hook sites; the
  consumer re-validates defensively).
- **`source`:** the choke point is deliberately **source-agnostic** — it cannot know
  whether the caller was a punch, a corrosion tick, or a stat effect, and the world law
  does not care (the drop is identical regardless of source). The consumer therefore
  carries no `source` field; if a future token ever needs source attribution, the
  listener signature is the extension point (append an optional `sourceTag` argument —
  no schema change). This satisfies R1 without leaking caller identity.
- Derived at the consumer (not passed): `damageAmount = clamp(oldValue − newValue, 0, max(0, oldValue))`
  — the amount actually removed (same clamped-loss semantics as the damage handler's
  `appliedLoss`).

### 3.3 Consumer — new `OnDamageDropListener`

New module [`src/controllers/worldRules/OnDamageDropListener.js`](src/controllers/worldRules/OnDamageDropListener.js)
(a focused actor, **not** a state owner — same shape as
[`MaterialChunkDropHandler`](src/controllers/consequences/MaterialChunkDropHandler.js)).
Deliberately placed in the `worldRules/` directory: it is the enforcement arm of the
world-rules layer (the torn stream has no separate actor — it rides the punch
consequence; the onDamage stream cannot, by R1).

```
constructor(deps = {})
  deps: { materialController: MaterialController|null,
          worldRulesController: WorldRulesController|null }
  this.worldStateController = null          // facade via setter (post-construction)
  this._randomFn = Math.random              // public test seam (documented)

setWorldStateController(world)              // setter pattern (precedent: the consequence handlers)

handleDamage(componentId, traitId, statName, oldValue, newValue)   // the listener body
```

**`handleDamage` algorithm** (every step null-tolerant; a failed pre-condition returns
silently, except where a warn is specified):

1. `world = this.worldStateController` — null → return (unwired facade).
2. `entries = this.worldRulesController?.getOnDamageRules() ?? []` — empty → **return
   (fast path: file degraded or rule absent costs one getter call and nothing else)**.
3. `comp = world.getComponent(componentId)` — null or no `comp.type` → return
   (component vanished or non-component).
4. **Total-loss skip (D10 mirror, see §3.5):**
   `if (traitId === TRAIT_GROUPS.PHYSICAL && statName === STAT_NAMES.EXISTENCE
        && typeof newValue === 'number' && newValue <= EXISTENCE_GONE_AT) return;`
   (constants from [`shared/StatVocabulary.js`](shared/StatVocabulary.js:78) /
   [`EXISTENCE_GONE_AT`](shared/StatVocabulary.js:168) — no magic numbers).
5. Resolve once (shared by all entries):
   - `entity = world.getEntity(comp.entityId)` — null → return.
   - `materials = world.componentController?.getComponentMaterialsByType?.()[comp.type]` —
     not a non-empty array → `Logger.warn` (no composition to resolve) + return.
   - `recipeVolume = getDefinitionVolume(world.componentController?.getComponentDefinition?.(comp.type))`
     ([`src/utils/definitionVolume.js`](src/utils/definitionVolume.js)).
   - `materialRegistry = world.getMaterialRegistry?.()?.materials || {}` (display names;
     same read as the chunk handler, line 116).
   - `damageAmount = clamp(oldValue − newValue, 0, max(0, oldValue))` (numeric inputs validated first; non-numeric old/new → return).
6. **Per entry, in array order — the independence loop** (each entry is a separate
   Bernoulli trial; a failure of one never short-circuits the others):
   - `if (!(this._randomFn() < entry.percentage)) continue;`
     (independent `Math.random`-draw per entry; `percentage` 0..1 already validated).
   - `switch (entry.drop)`:
     - **`'host_material'`:**
       1. `primary = this.materialController?.getPrimaryMaterial(materials) ?? null`
          (new method, §3.4) — null → `Logger.warn` + skip entry.
       2. Volume:
          - existence damage (`Physical.existence`, `damageAmount > 0`):
            `volume = max(minChunkVolume, chunkFraction × damageAmount × primary.fraction × recipeVolume)`
            where `minChunkVolume = this.materialController?.getMinChunkVolume() ?? 0` and
            `chunkFraction = (this.materialController?.getDropRate(primary.material) ?? null)?.chunkFraction ?? FULL_MATTER_SHARE`
            (`FULL_MATTER_SHARE = 1.0`, a named constant in the new shared helper, §3.6).
          - any **non-existence** stat decrease: `volume = minChunkVolume`
            (a nominal floor-size chip — no matter-math exists for non-existence stats,
            and the floor guarantees a physically meaningful token; when the drop-rates
            feature is off, `minChunkVolume` is 0 and such a token is simply not
            meaningful → **skip** the token in that case rather than write a 0-volume item).
       3. `point = sampleDiskPoint(entity.spatial?.x ?? 0, entity.spatial?.y ?? 0, DEFAULT_TRIGGER_RADIUS)`
          — null → skip (same placement law as the chunk stream).
       4. `itemDef = buildChunkItemDef(materialName, volume)` (shared helper, §3.6) with
          `itemType = CHUNK_ITEM_TYPE_PREFIX + primary.material` — the **same** item
          identity mechanics as the chunk stream (self-describing, no registry entry).
       5. Accumulate into a local batch object via the **same narrow-deps
          `writeDroppedItem` pattern** the chunk handler uses (lines 118–124 / 153 of
          [`MaterialChunkDropHandler`](src/controllers/consequences/MaterialChunkDropHandler.js:118)):
          `{ getDroppedItems: () => batch, setDroppedItems: (items) => Object.assign(batch, items) }`.
     - `default:` `Logger.warn` (unreachable if validation held; defense in depth).
7. After the entry loop, if the batch is non-empty: **one** `world.setDroppedItems(batch)`
   (batched-write precedent, D6) + a single `Logger.info` line
   (`[OnDamageDropListener] Dropped N onDamage token(s) for <componentId>: <token summary>`).

**Re-entrancy / safety:** the consumer only *reads* component/entity/material state and
*writes* ground state (`droppedItems`). It never calls `updateComponentStat*`, so the
hook cannot re-enter itself or disturb the in-flight stat update; the ground write lands
in the same stat-change broadcast the facade already emits for the stat change (no new
event protocol, no client changes — the self-describing ground record, D8).

### 3.4 `host_material` resolution — largest composition fraction

New public method on [`MaterialController`](src/controllers/materials/MaterialController.js)
(placement rationale: composition-selection math belongs to the material owner, exactly
like the existing blended-damage-type split):

```
getPrimaryMaterial(materials): { material: string, fraction: number } | null
```

- Input: the component type's composition array (the same array the chunk handler reads
  via `getComponentMaterialsByType()`).
- Returns the entry with the **largest numeric `fraction`**.
- **Tie-break: first entry in array order** (stable, deterministic, documented — the
  composition order in `data/components.json` is the stable canonical order).
- Returns `null` when the input is not a non-empty array of plain objects with a
  non-empty string `material` and a finite numeric `fraction` (≥ 0).
- Pure function of its input — no I/O, no other state; JSDoc'd; returns a defensive
  copy of the chosen entry.

Worked examples from [`data/components.json`](data/components.json):
`droidHand` (`iron 0.7 / wood 0.3`, lines 21–29) → `iron`;
`merchantHead` (`iron 0.6 / wood 0.4`) → `iron`;
`droidHead` (iron 1.0) → `iron`.

### 3.5 The total-loss skip (why lethal hits drop nothing)

When a damage event drives `Physical.existence` to `<= 0`, the break/removal cascade
(spill of contents, component removal) already owns the total loss of that component —
the same rationale the chunk system encodes as spec decision D10 ("the target is gone …
there is no partial-matter source to chip from"). The onDamage token mirrors D10 at
step 4 of `handleDamage`. Consequences: a lethal punch produces **no** onDamage token
(but *does* still run its legacy chunk + torn streams — those run inside the damage
consequence, before/at the same event, unchanged); and because the damage handler's
`appliedLoss` clamp already caps the applied loss at the old existence, the token volume
formula can never create matter from a dead component either.

### 3.6 Shared helper extraction (single source for chunk-item mechanics)

To make "the same kind of item the chunk system produces" true *by construction* (not by
copy-paste), extract the spawn block duplicated between the chunk stream
([`MaterialChunkDropHandler` lines 141–152](src/controllers/consequences/MaterialChunkDropHandler.js:141))
and the new consumer into a new pure module
[`src/utils/materialChunkToken.js`](src/utils/materialChunkToken.js):

```
export const FULL_MATTER_SHARE = 1.0;
// D7 volume (existing formula, unchanged): max(min, chunkFraction × loss × fraction × volume)
export function computeChunkVolume(dropConfig, appliedLoss, fraction, recipeVolume, minChunkVolume)
// the self-describing item definition (name/description/volume), identical strings
export function buildChunkItemDef(materialName, volume)
```

- `computeChunkVolume` handles `dropConfig === null` via `?? FULL_MATTER_SHARE` (the
  consumer's fallback when the drop-rates file is absent). For the **existing** call
  sites `dropConfig` is always non-null, and the expression evaluates to the exact
  current float sequence `Math.max(minChunkVolume, chunkFraction × appliedLoss ×
  fraction × recipeVolume)` — so the refactor is line-for-line equivalent and the chunk
  stream stays bit-identical (the torn stream at line 176 keeps its own distinct formula
  and is **not** routed through this helper).
- `buildChunkItemDef` reproduces the current `itemDef` object
  (`name: "<Material> chunk"`, `description: "A chunk of <Material> chipped off a damaged
  component."`, `volume`) exactly — same strings, so onDamage tokens are the same kind
  of item as chunk-stream tokens (indistinguishable on the ground: an accepted tradeoff
  the torn stream already documents).
- `MaterialChunkDropHandler` is refactored to call these two functions at its two
  existing chunk-stream sites (lines 141–152; the torn stream is untouched).
- `writeDroppedItem` + `sampleDiskPoint` + `CHUNK_ITEM_TYPE_PREFIX` stay where they are
  (the consumer imports them directly, exactly as the chunk handler does).

## 4. Public API + DI wiring

### 4.1 `WorldRulesController` additions

| Member | Kind | Contract |
|---|---|---|
| `this._events` | private | `{ onDamage: Array<{drop, percentage}> }` — validated, active entries only. |
| `getOnDamageRules()` | public | Defensive deep copy of the active `onDamage` entries; `[]` when absent/malformed/degraded/unwired. JSDoc'd. |
| `KNOWN_EVENT_KEYS` | module const | `new Set(['onDamage'])` — future event keys added here. |
| `KNOWN_DROP_TOKENS` | module const | `new Set(['host_material'])` — future tokens added here. |

**Untouched (explicit):** `getRule()`, `isRuleActive()`, `getActiveRules()`,
`getDamageTornMaterialPercent()`, `getWorldRules()` (facade), `getAll()` (doesn't exist,
by design), the constructor signature, and the entire `_validateRuleConfig` branch for
`damageTornMaterial`. `onDamage` is **not** added to `KNOWN_RULE_KEYS` (that set is for
scalar-config rules); it is a separate known-key set, so `getActiveRules()` — and therefore
the facade's `getWorldRules()` and every existing assertion on its shape — remains
bit-identical.

### 4.2 `WorldStateController` (facade)

- **Added:** one null-tolerant deps entry `onDamageDropListener` (stored as a plain
  public property — **not** in the `this.subControllers` broadcast map at
  [lines 165–179](src/controllers/WorldStateController.js:165): it is an actor with no
  `getAll()`, same exclusion rule as `worldRulesController`).
- **Added:** in the constructor, next to the stat-change registration (line 198):
  register the consumer on the new damage-listener list:
  `this.componentController.registerDamageListener((componentId, traitId, statName, oldValue, newValue) => { this.onDamageDropListener?.handleDamage(componentId, traitId, statName, oldValue, newValue); });`
  (null-tolerant arrow — a hand-built facade without the listener is a no-op).
- **Untouched:** everything else — `getWorldRules()`, the stat-change listener (lines
  198–244, including the broke delegation and broadcast), `getComponent`, `getEntity`,
  `setDroppedItems`, the batch-spill write path, `getAll()`, broadcast aggregation.

### 4.3 `WorldComposition` (composition root)

- Construct the consumer **before** the facade (Layer-3 area, next to
  `consequenceHandlers` at [line 240](src/composition/WorldComposition.js:240)):
  `const onDamageDropListener = new OnDamageDropListener({ materialController, worldRulesController });`
  (both already in scope: lines 157 / 163 — no new `DataLoader` call, no new file I/O).
- Pass it in the facade deps bag (next to `worldRulesController`, line ~317).
- Post-construction injection (step 3, alongside line 333):
  `onDamageDropListener.setWorldStateController(worldStateController);`
- Add `onDamageDropListener` to the returned `subControllers` inspection map
  (lines 379–419) as inspection-only (no `getAll()` → stays out of the broadcast
  aggregation, same comment style as `worldRulesController`).

### 4.4 Project-rule compliance (checklist for the code subtask)

- JavaScript only; JSDoc on all new public methods; semantic names; no magic numbers
  (`EXISTENCE_GONE_AT`, `FULL_MATTER_SHARE`, `DEFAULT_TRIGGER_RADIUS`,
  `CHUNK_ITEM_TYPE_PREFIX`); `Logger` only (no `console.*`); defensive deep copies from
  new getters; the consumer touches no other controller's internals (facade public API
  only); data loads only through the existing `DataLoader.loadJsonSafe` at the
  composition root (the controller itself does no I/O, per its pattern).

## 5. Validation plan

### 5.1 File-level (degradation contract — R6, unchanged from the torn layer)

Handled by the **existing** `_validateWorldRules` top-level flow (no change to it):
- `null`/`undefined`/non-object/array registry → all rules **and** all events off, one
  warn, **no throw**.
- `rules` absent/null/non-object/empty → all rules and all events off, warn, no throw.
  (Events live *inside* `rules`, so they degrade with the section — there is no event
  that survives a broken `rules` section; this keeps the file's structural contract
  singular.)
- The file edit in §2.1 adds a sibling key only: a file without `onDamage` (old file on
  new server) validates exactly as today; a file with `onDamage` on an old server hits
  the existing unknown-key warn-and-ignore branch (forward compatibility both ways).

### 5.2 `onDamage` section-level validation (new branch, per-key loop)

In the per-key loop of `_validateWorldRules` (line 113), after the `_`-metadata skip:
- key in `KNOWN_EVENT_KEYS` (`onDamage`) → validate as an **event table**:
  - not an array → the event is off: warn + store `[]` (the section is malformed; every
    other key — including `damageTornMaterial` — is unaffected).
  - array (possibly empty) → per-entry validation below; store the surviving entries.
  - **No throw at this level** (degradation contract). An empty array is valid
    (rule present, zero entries → nothing to roll, no warning).

### 5.3 Per-entry rejection conditions (R6: warn + skip, never fatal)

Each entry that fails **any** condition is skipped with a `Logger.warn` naming the
entry index and the reason; all other entries survive:

| # | Rejection condition |
|---|---|
| E1 | entry is `null`, not an object, or an array |
| E2 | `drop` missing, not a string, or not in `KNOWN_DROP_TOKENS` |
| E3 | `percentage` missing, not a `number`, not finite, or outside `[0, 1]` (so `1.5`, `-0.1`, `"0.05"`, `NaN`, `null` all reject; `0` and `1` are **valid** boundary values) |

Unknown extra fields on a valid entry are ignored (forward compatibility). Valid entries
are stored normalized to `{ drop, percentage }` (extra fields dropped at storage —
defense against future shape drift).

### 5.4 Independence of validation between keys

The per-key loop is structurally independent: a malformed `onDamage` entry never touches
`this._rules['damageTornMaterial']`, and a malformed `damageTornMaterial` config never
touches `this._events.onDamage`. The initialization summary
([`_logSummary`](src/controllers/worldRules/WorldRulesController.js:188)) keeps the
existing `X/Y rule(s) active (...)` prefix **verbatim** (the unit test's unanchored
regex depends on it) and **appends** an event clause after it, e.g.
`… (none); events: onDamage 1/1 entr(y/ies) active.`

### 5.5 Runtime tolerance (per event, not per load)

`handleDamage` is fully null-tolerant by construction (§3.3 steps 1–6): unwired facade,
unwired controllers, vanished component/entity, missing composition, non-numeric
values, zero-volume floor — every pre-condition fails to a silent return or a single
warn, never an exception, never a partial write (the batch is written once, at the end,
only if non-empty).

## 6. Independence proof (R4, R5)

1. **Separate data owners, separate storage, separate validation state.** The legacy
   roll reads `materialController.getDropRate(m)` / `getMinChunkVolume()`
   (`data/materialDropRates.json`); the onDamage roll reads
   `worldRulesController.getOnDamageRules()` (`data/world_rules.json`). Neither controller
   reads the other's file or state.
2. **Separate roll calls, never re-used.** The legacy chunk roll is
   `Math.random() < dropRate` inside the punch consequence
   ([line 139](src/controllers/consequences/MaterialChunkDropHandler.js:139)); the onDamage
   roll is `this._randomFn() < percentage` inside the stat-choke-point hook. Two distinct
   draws per damage event; P(both fire) = p_legacy × p_onDamage — pure Bernoulli
   independence (no shared RNG state, no shared counter). The onDamage consumer never
   writes to the published-loss key, the dispatch context, or any consequence state.
3. **Additive, not competing, on the ground.** Both streams write self-describing
   `chunk_<material>` records into the same `droppedItems` map through the same
   `writeDroppedItem` helper with independently minted record ids — records with the
   same item type already coexist today (the chunk + torn streams both land in one
   punch, per the existing contract tests), so a third record is structurally
   indistinguishable and additive. No shared mutable state exists between the streams.
4. **The legacy stream is bit-for-bit unchanged.** The only legacy code touched is the
   line-for-line-equivalent helper extraction (§3.6: identical float expression
   sequence, identical strings). The torn stream's formula (line 176), gate (line 181),
   percent reader (line 168) and the `damageTornMaterial` rule config/validation are
   untouched. The damage handler's applied-loss clamp/publication is untouched.
5. **Failure isolation.** The damage-listener notification wraps each listener in its own
   `try/catch` + `Logger.error` (same as the stat-change list): a consumer exception
   cannot alter the applied loss, the consequence result, the break cascade, or the
   broadcast. The hook fires *after* the stat write, so it can never change what damage
   was applied (read-only over the stat pipeline).
6. **Consequence for existing tests.** Because the legacy streams are unchanged, every
   existing torn/chunk assertion stays valid **as written** — with one mechanical
   exception: tests that count ground records exactly now also see the new Bernoulli
   stream in the world. The code subtask must pin that stream in those tests by setting
   the consumer's documented test seam to always-fail (one line each; §7.4). No
   assertion in any existing test is modified.

## 7. Test strategy

Conventions (mirroring the existing suites): contract tests build the real facade via
[`buildWorldState`](src/composition/WorldComposition.js) (hand-constructed test registries
where needed), drive damage through the public API, and read `getDroppedItems()`;
`world.onDamageDropListener._randomFn = fn` is the seam for pinning the new roll.

### 7.1 Unit — `test/unit/WorldRulesController.test.js` (extend the existing file)

| Test | Behavior covered |
|---|---|
| Valid entry: `getOnDamageRules()` returns a deep copy of `[{drop:'host_material', percentage:0.05}]`; mutating the copy does not affect the registry | R2/R3 schema; defensive copies |
| File without `onDamage` → `[]` | backward compat (old file) |
| `onDamage` not an array (object/string/number) → `[]`, no throw, warn | §5.2 section-level degradation |
| Entry non-object (string/number/null/array) → skipped, others kept | E1 |
| Entry `drop` missing / non-string / unknown token → skipped | E2 |
| Entry `percentage` missing / non-numeric / NaN / `1.5` / `-0.1` → skipped; `0` and `1` accepted | E3 + boundary values |
| Unknown extra field on a valid entry → ignored (stored normalized) | forward compatibility |
| Malformed `onDamage` leaves `getDamageTornMaterialPercent()` intact — and vice versa | §5.4 key independence |
| Degradation: `null` registry / `rules` missing / `rules` empty → `[]` **and** torn percent `0`, no throw | R6 |
| Summary line still matches the existing unanchored `/X\/Y rule\(s\) active/` prefix | unit-test compatibility (§5.4) |

### 7.2 Unit — `MaterialController.getPrimaryMaterial` (extend
[`test/unit/materialDropRates.test.js`](test/unit/materialDropRates.test.js) or a sibling file)

Single-material composition → that material; multi with a clear max → the max; exact tie
(0.5/0.5) → **first in array order**; non-array / empty / malformed entries / missing
fraction → `null`; result is a defensive copy.

### 7.3 Unit — new `test/unit/OnDamageDropListener.test.js`

Stub-deps pattern (a makeListener-style helper with a stub facade exposing
`getComponent/getEntity/getDroppedItems/setDroppedItems/getMaterialRegistry` and a stub
`componentController`), seam `_randomFn`:

| Test | Behavior covered |
|---|---|
| No entries (`getOnDamageRules()` → `[]`) → zero facade drop-writes | fast path |
| Roll failure (seam `() => 1`) → no drop | R2 failure path |
| Roll success (seam `() => 0.01`) + existence damage → exactly one `chunk_<primary>` record; volume `= max(minChunk, chunkFraction × damageAmount × fraction × V)` (existence case); in the entity's room; within `DEFAULT_TRIGGER_RADIUS` of the entity position; exactly one `setDroppedItems` call (batched) | R3, §3.3, §3.6 |
| Multi-material: composition iron 0.7 / wood 0.3 → token is `chunk_iron` at `fraction 0.7` volume | R3 largest-fraction |
| Non-existence stat damage (e.g. `strength` delta) → floor-volume token (or skipped when `minChunkVolume` is 0) | R1 non-existence case |
| Existence crossing to `<= 0` → **no** token (D10 mirror) | §3.5 |
| `getComponent` → null (vanished) → no drop; entity null → no drop | §3.3 null-tolerance |
| Two entries, seam sequence `[0.99, 0.01]` → first fails, second succeeds → exactly one drop (independence within one event) | R2 |
| Unwired facade / unwired controllers → silent return | R6 runtime |

### 7.4 Existing contract suites — the one-line mechanical pin (mandatory)

`world.onDamageDropListener._randomFn = () => 1;` (always-fail → the onDamage stream is
deterministically silent; the legacy streams use their own `Math.random` and are
unaffected). The pin makes the test world **identical to the pre-feature world**, so no
assertion in these suites is modified.

**Uniform rule per suite:** insert the one-line pin after world construction in every
test of the affected suites that builds a live world from the shipped data files.
(Tests that hide/empty `data/world_rules.json` via file swap do not need it — the rule
is off there — but applying the pin uniformly per suite is simpler and equivalent.)

Verified must-pin tests (exact-count or RNG-queue assertions the new stream would
otherwise perturb):

| File | Test(s) and why |
|---|---|
| [`test/contract/materialChunkDrop.contract.test.js`](test/contract/materialChunkDrop.contract.test.js:108) | "DROP ON HIT: punch an iron head → exactly one chunk_iron … D7 volume" (asserts exactly 2 `chunk_iron` records); "PER-MATERIAL INDEPENDENCE: punch a two-material hand → iron always, wood at most one, no material twice (D12)" (asserts iron = exactly 2, wood ≤ 2) |
| [`test/contract/materialChunkDropCutShootT1.contract.test.js`](test/contract/materialChunkDropCutShootT1.contract.test.js:80) | "CUT ON HIT: … exactly one chunk_iron with the D7 volume" (asserts exactly 2); "SHOOT T1: firing the T1 sheds a chunk at the minChunkVolume floor" (asserts exactly **1** — the torn stream is gated out by the floor there, but the onDamage token is not, so this test would flake ~5% without the pin) |
| [`test/contract/worldRulesTornMaterial.contract.test.js`](test/contract/worldRulesTornMaterial.contract.test.js:230) | "1. Rule ON, deterministic drop … exactly two chunk_iron records", "2. Multi-material target …", "5. Gate edge …", "7. Multi-attacker: two-fist punch … four total" (exact counts) |
| [`test/contract/doublePunchChannelDamage.contract.test.js`](test/contract/doublePunchChannelDamage.contract.test.js:229) | the per-fist chunk count test (exactly 4 total), the RNG-queue "per-roll independence" test (**mandatory** — the queue is consumed by the new stream's rolls and the test breaks ~100% of the time without the pin), and the feature-off ground-count test (drop-rates file hidden → `minChunkVolume` 0, `chunkFraction` fallback 1.0 → the onDamage token is still droppable, so the exact ground delta would flake) |

**Full-suite acceptance:** after the implementation, run the entire test suite. Any
*other* suite that builds a live world from the shipped files and asserts exact ground
record counts (candidates to watch: `crafterDrone.contract.test.js` — asserts an empty
ground at the end of its flow; `triggerComponentBroke.contract.test.js` — break/spill
ground counts, where the hook is already silent on the lethal hits but may fire on
non-lethal damage steps) receives the same one-line pin until green. Keep the final pin
list minimal and record it in the PR description. No assertion in any existing test is
modified.

### 7.5 New contract suite — `test/contract/worldRulesOnDamage.contract.test.js`

Full round-trip with the shipped 5% rule (real facade, real data files), seam-driven:

| Test | Behavior covered |
|---|---|
| **Roll success:** seam `() => 0.01`, non-lethal punch on a 100%-iron component (e.g. `droidHead`, V=8) → ground contains the legacy chunk (D7, `chunkFraction 0.3`), the torn token (`10% × L × 8`), **and** the onDamage token (same D7 volume for iron — assert by counts: 2 records at the D7 volume + 1 at the torn volume), all within the trigger radius of the entity | R1 (channel source), R2 success, R3, R4 additivity |
| **Roll failure:** seam `() => 1` → exactly the legacy records (chunk + torn), no third record | R2 failure |
| **Independence from the legacy drop:** seam success with iron `dropRate 1.0` → all three streams present simultaneously; legacy volumes remain formula-exact (the onDamage stream did not perturb them) | R4 |
| **Largest-fraction selection:** punch a multi-material component (`droidHand`: iron 0.7 / wood 0.3, V=6) → the onDamage token is `chunk_iron` at `max(0.05, 0.3 × L × 0.7 × 6)` — never wood | R3 resolution rule |
| **Non-channel source (direct stat delta):** seam success; `world.componentController.updateComponentStatDelta(handId, 'Physical', 'strength', -5)` → a floor-volume token appears (no punch involved) | R1 (stat effects) |
| **IC-tick source:** install the real `corrosiveGland` organ (corrosion, `intervalTicks 10`, [`data/internalComponents.json`](data/internalComponents.json:64)) on a nearby component via the internal-component controller's public install API, advance ticks past one interval → an onDamage token appears with no punch/cut/shoot in between | R1 (IC ticks) |
| **Lethal punch:** seam success; punch to `existence <= 0` → **no** onDamage token from the hook (break/spill cascade runs instead) | §3.5 (D10 mirror) |
| **Torn-rule regression (in-world):** with the onDamage rule active, the torn token's volume is still `(10/100) × L × fraction × V` and the chunk stream still rolls per `materialDropRates.json` | R5 |
| **File degradation (missing):** hide the file (copy the rename-swap helper from the torn contract test) → world builds, `getOnDamageRules()` → `[]`, a punch behaves bit-identically to legacy (only the legacy streams' records) | R6 |
| **File degradation (malformed entry):** swap in a temp file with `onDamage: [ { "drop": "bogus", "percentage": 4 } ]` + the normal `damageTornMaterial` → entry skipped (warn), torn rule still active at 10% | R6 per-entry |

## 8. Wiki / map maintenance (why-level content only — no code, no schemas, no flows)

| Target | Update |
|---|---|
| [`wiki/subMDs/data/world_rules.md`](subMDs/data/world_rules.md) | New section for the `onDamage` event rule: **why** a probabilistic event law lives in the world-rules layer (it is a law of the world, not a balance lever — balance levers stay in the per-material files); **why** each entry is an independent trial per event rather than one shared roll (entries compose without interfering, mirroring how materials already roll independently); **why** `host_material` resolves to the largest-fraction material (the material that *is* the component in the player's model); **why** total-loss hits drop nothing (matter ownership of a vanished component belongs to the break flow — consistency with the chunk system's same decision); **why** malformed entries degrade per-entry (a balance file must never crash the world; per-entry tolerance keeps the rest of the table alive). |
| [`wiki/subMDs/data/material_damage_and_drop.md`](subMDs/data/material_damage_and_drop.md) | Extend the torn-stream section with the third stream: **why** the onDamage token shares the chunk item mechanics and the D7 volume lever (one notion of "a chip of matter" in the world; the token is the same kind of thing, so nothing new to teach clients or recipes); **why** it dispatches at the stat choke point rather than as a consequence (the law applies to *any* weakening — corrosion, holding cost, stat effects — not only to punches). |
| [`wiki/map.md`](map.md) | Data Files table row for `data/world_rules.json`: mention the `onDamage` event rule (one clause). Dependency graph: add the `OnDamageDropListener` node with edges in the existing style — `WSC -->|injected; inspection| ODL`, `ODL -->|event table| WRC`, `ODL -->|chunk levers| MC`, `CC -.->|damage event| ODL` (dashed = observer, mirroring the existing `CC -.-> WSC` stat-change edge). |
| [`wiki/subMDs/system_map.md`](subMDs/system_map.md) | The deep map: same node + edge additions as `map.md` (the two maps must stay in sync). |
| [`wiki/subMDs/controllers/consequence_handler_architecture.md`](subMDs/controllers/consequence_handler_architecture.md) | One paragraph: **why** the onDamage hook is *not* a consequence (consequences are action-scoped and ordered per action definition; this law is source-agnostic and fires even when no action is in flight — an IC tick — so it hooks the stat choke point instead). |

All updates obey the why-over-how rule (BUG-072 precedent): no code snippets, no JSON
schemas, no step-by-step flows.

## 9. Risks / open items for the code subtask

1. **Existing tests get one line each** (§7.4) — the only deviation from "existing tests
   pass without modification" is the mechanical seam pin, forced by the shipped 5% rule
   adding a real Bernoulli stream to worlds those tests count exactly. No assertion is
   changed. If the reviewer refuses even that, the only alternative is shipping
   `percentage: 0` (inert) — which violates the confirmed semantics; flagged for the
   user, not for the code subtask.
2. `_randomFn` is a **public, documented test seam** (not underscore-private-privilege):
   tests set it directly; production never does. Keep the JSDoc note ("test-only seam").
3. The onDamage token is intentionally **indistinguishable** from chunk-stream tokens on
   the ground (same `chunk_<material>` identity) — same accepted tradeoff the torn
   stream already documents; do not "fix" it by inventing a new item type.
4. Volume fallback when the drop-rates file is absent: `FULL_MATTER_SHARE = 1.0`
   (token = the actual lost matter) rather than skipping — the world law must not
   depend on the presence of the balance file. Documented choice; keep the constant named.
5. **No** broadcast/client change: the token rides the existing stat-change broadcast as
   a ground record (D8 precedent). If a future feature needs the client to *distinguish*
   onDamage tokens, that is a protocol change out of scope here.
6. `percentage` (0..1 probability) vs `percent` (0..100 share) is an intentional
   scale difference; keep the JSDoc on `getOnDamageRules()` explicit so the drift never
   happens silently.
7. The IC-tick contract test (§7.5) depends on the internal-component controller's
   public install API and on advancing the unified tick system past
   `intervalTicks: 10` — the code subtask should reuse whatever tick-advance pattern the
   internal-component tests already use (do not invent a new one).
