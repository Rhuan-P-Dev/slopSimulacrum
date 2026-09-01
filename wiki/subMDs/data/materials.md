# Material System (Composition-Driven Stat Derivation)

## Why a 3-Layer Separation?

The original proposal — "each material grants traits, the % defines trait strength" — creates an **N×M tuning matrix**: every new material × every new stat requires hand-tuned coefficients. This is brittle and doesn't scale.

The fix: three isolated layers with single-responsibility data structures:

```
Material (pure physics)  →  Composition (fractions)  →  Derivation (one mapping table)  →  Derived stats
```

Materials **never** define stats directly. They define raw physical properties on a 0–100 scale. A **single shared derivation table** converts the blended properties into the basic stat set — the six channel resistances, mass, sharpness, and the threshold-derived flags; existence tracks the remaining matter itself. Result: **new material = 1 row in `materials.json`; new property = 1 mapping row.** Balance levers live in exactly one place.

## Why Composition Is Part of the Recipe

In the recipe model, a blueprint declares **form, material composition, and pre-installed organs** — and no stat values. The material composition is not a gap-filling layer beneath hand-tuned blueprint numbers; it is **the source of the component's physical stats**.

This placement is deliberate:

1. **One source per stat.** Matter gives the physical stats, form gives size, organs give function. A value with two sources is a value that cannot be trusted — the derivation invariant dies if any stat can be both derived and hand-set (see [Traits System](traits.md)).
2. **Composition must be consequential.** The N×M problem was already solved by the mapping table; the recipe only picks the composition. What something is made of now changes what it is — a cut is trivial on iron, fatal on a cable.
3. **No phantom values.** With no global molds and no blueprint stat overrides, there is no baseline that can leak into a component's stat set — a component has exactly the stats its matter, form, and organs justify.

The old "blueprints without a materials field produce byte-identical stats" guarantee was a migration vehicle for introducing the layer incrementally. In the target model, composition is part of the recipe itself, so the opt-in story is retired.

## Data Model

### `data/materials.json`

Each entry declares one raw material's physical profile: a density (so mass can be derived from how much of the material an object contains and how big the object is) and a set of physical properties on a shared 0–100 scale. The property set maps **one-to-one onto the six damage channels** — cut, impact, wear, heat, electricity, corrosion — three as resistance and three as susceptibility inverted at conversion, so no new material science is invented when the channel resistances are derived. What matters conceptually is that materials describe *what something is made of*, never *how it plays*.

### `data/propertyTraitMapping.json`

This single table is the **only place where physical properties are translated into derived stats** — the expanded heart of the basic stat set:

- **Mass** — derived from the composition's density weighted by each material's share, scaled by the component's volume, so mass stays physically consistent with what an object is made of and how big it is.
- **The six channel resistances** — each is a deliberate mix of the composition's blended properties (cut, impact, wear, heat, electricity, corrosion), so what resists a given channel is a physical statement, not a tuning choice.
- **Sharpness** — a depletable quality of the edge material: as edge matter is consumed, the derived sharpness falls.
- **Existence** — a 0–1 ratio of the matter that remains, re-derived as the composition thins; it is the component's life.
- **Named flags** — a property crossing a declared threshold marks the component (flammable, conductive). Flags gate channels and interactions; they never patch numbers.

The exact weights and thresholds live in the data file and are the only balance levers for derived stats.

## Derivation Pipeline

Derivation turns a recipe's composition into derived stats in three conceptual stages: the composition is validated for consistency, the materials' properties are blended into a single profile weighted by each material's share, and the mapping table converts that profile into the stat set. Fail-fast validation means a malformed composition is rejected at derivation time instead of silently producing wrong stats.

Because stats are **re-derived** from the remaining matter, form, and organs — never stored as independent values — a component whose composition has thinned (it lost its iron, kept its wood) carries different resistances, a different sharpness, and a different existence than an identical recipe that has not been damaged. Identity drift is emergent, not scripted.

## Validation

Validation is intentionally strict and fail-fast: registry defects (malformed entries, invalid mapping keys) are caught once at boot, and per-composition defects (unknown material references, non-positive fractions, fractions that over-sum) are rejected the moment a composition is derived. Data errors surface immediately, at the point where they originate, instead of propagating as silent stat corruption.

## Persistence

Matter is the **only per-instance store**: the world state persists what a component is made of and how much of it remains, plus any transient conditions. Everything else — resistances, mass, sharpness, existence — is re-derived from matter, form, and organs, so a restored snapshot and the live world cannot disagree about what a component is.

**Why this matters.** The old world carried two stores describing the same thing (a `durability` "health" and inert materials) and paid for their desynchronization (see [BUG-017](../../bugfixWiki/architectural/BUG-017-dual-state-bug.md)). With one store, save/load and client/server sync are trustworthy by construction. Old-format snapshots that persisted per-instance stat values are a migration concern only: the fill-only gap-filling sync that guarded that migration (persisted values preserved, missing ones filled, never retroactively re-tuned) is covered by contract tests in [`test/contract/materialTraitsPersistence.contract.test.js`](test/contract/materialTraitsPersistence.contract.test.js).

## Items Are Small Components

Inventory items are no longer an exception to the model — they are **small components**: their own matter, their own organs, their own existence. Material derivation applies to an item exactly as it applies to a component, because derivation depends only on the item's own recipe — the hosting component does not influence it. This is what makes the "fresh meat" system core instead of a special case: items carried by NPCs can be destroyed and drop as salvage, with the matter they are made of — not an opaque health bar — explaining how far they got.

## Client Display (Implemented)

Material composition is displayed on component cards and item cards as always-visible inline badges with role labels, so players can see what something is made of without opening a detail view. A single badge style is shared across the component and inventory panels rather than duplicated per panel.

## Related Code

- [`src/controllers/materials/MaterialController.js`](src/controllers/materials/MaterialController.js:1) — pure derivation logic, no facade dependency
- [`src/controllers/traits/TraitsController.js`](src/controllers/traits/TraitsController.js:45) — carries the derived stat set into component state
- [`src/controllers/core/componentController.js`](src/controllers/core/componentController.js:96) — component initialization consumes the recipe (form, composition, pre-installed organs)
- [`src/composition/WorldComposition.js`](src/composition/WorldComposition.js:130) — wires the material layer into world composition
- [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js:54) — item-side derivation: items are small components with their own matter

## Phase 2 (Deferred)

Separate channel-resistance stats and channel-based damage are **no longer deferred** — they are the core of the basic set ([spec](../../basic_traits_and_stats_spec.md)). What remains deferred:

- Environment/room traits (wet rooms, fire zones)
- Non-linear material interaction rules beyond what channels already express (pair-based effects like wet wood, iron rusting)
- Recursive ICs (organs with their own matter)
- Per-instance material choice via crafting
- World map tooltips showing material composition
- More materials: rubber, cloth, plastic, crystal
