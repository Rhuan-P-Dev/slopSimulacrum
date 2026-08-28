# Material System (Composition-Driven Trait Derivation)

## Why a 3-Layer Separation?

The original proposal — "each material grants traits, the % defines trait strength" — creates an **N×M tuning matrix**: every new material × every new trait requires hand-tuned coefficients. This is brittle and doesn't scale.

The fix: three isolated layers with single-responsibility data structures:

```
Material (pure physics)  →  Composition (fractions)  →  Derivation (one mapping table)  →  Existing traits
```

Materials **never** define traits directly. They define raw physical properties on a 0–100 scale. A **single shared derivation table** converts the blended properties into existing trait stats. Result: **new material = 1 row in `materials.json`; new property = 1 mapping row + 1 global default.** Balance levers live in exactly one place.

## Why the Material Layer Sits Below Blueprint Overrides

The merge order is:

```
Global Defaults → Material-Derived → Blueprint Overrides → Initial Overrides (runtime)
```

This placement is intentional:

1. **Hand-tuned blueprints win.** Every existing component has carefully tuned stats (`durability: 100`, `mass: 20`, etc.). These must not change when materials are added.
2. **Materials fill gaps.** For stats the blueprint doesn't hand-tune (e.g., `flammability`), the material layer provides physically-consistent defaults.
3. **Backward compatibility.** Blueprints **without** a `materials` field produce byte-identical stats — zero regression for existing content.

## Data Model

### `data/materials.json`

Each entry declares one raw material's physical profile: a density (so mass can be derived from how much of the material an object contains and how big the object is) and a set of physical properties on a shared 0–100 scale — flammability, electrical conduction, moisture retention, cut/impact/wear resistance, and heat conduction. What matters conceptually is that materials describe *what something is made of*, never *how it plays*.

### `data/propertyTraitMapping.json`

This single table is the only place where physical properties are translated into trait stats. It supports two kinds of derivation:

- **Mass** — derived from the composition's density weighted by each material's share, scaled by the component's volume, so mass stays physically consistent with what an object is made of and how big it is.
- **Derived stats** — computed as a weighted blend of the composition's blended source properties, so each target trait reflects a deliberate mix of underlying physical properties rather than any single one.

The current table covers mass, durability (a blend of wear, impact, and cut resistance), and flammability (a direct pass-through of the material's flammability property). The exact weights live in the data file and are the only balance levers for derived stats.

## Derivation Pipeline

Derivation turns a blueprint's composition into trait-shaped values in three conceptual stages: the composition is validated for consistency, the materials' properties are blended into a single profile weighted by each material's share, and the mapping table converts that profile into trait stats. Fail-fast validation means a malformed composition is rejected at derivation time instead of silently producing wrong stats.

## Validation

Validation is intentionally strict and fail-fast: registry defects (malformed entries, invalid mapping keys) are caught once at boot, and per-composition defects (unknown material references, non-positive fractions, fractions that over-sum) are rejected the moment a composition is derived. Data errors surface immediately, at the point where they originate, instead of propagating as silent stat corruption.

## Backward Compatibility

Blueprints **without** a `materials` field:

- Derivation contributes nothing for them
- The merge output is **identical** to the pre-material system behavior
- Every existing test stays green — zero regression

This is what made the material layer safe to introduce incrementally: existing content is untouched unless a blueprint opts in by declaring a composition.

## Related Code

- [`src/controllers/materials/MaterialController.js`](src/controllers/materials/MaterialController.js:1) — pure derivation logic, no facade dependency
- [`src/controllers/traits/TraitsController.js`](src/controllers/traits/TraitsController.js:45) — trait merge extended to accept material-derived values
- [`src/controllers/core/componentController.js`](src/controllers/core/componentController.js:96) — component initialization consumes derived traits
- [`src/composition/WorldComposition.js`](src/composition/WorldComposition.js:130) — wires the material layer into world composition
- [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js:54) — item-side derivation and restore gap-filling

## Item-Instance Material Derivation

Material traits are also derived for **inventory items**, not just components. This enables the "fresh meat" system where items carried by NPCs can be destroyed and dropped as consumable resources.

Derivation is best-effort by design: if it fails for an item, the item falls back to its raw blueprint traits with a logged warning instead of aborting the add. Blueprint-declared traits always win over material-derived values on conflict, consistent with the global merge order.

Items inside containers receive the same material-derived traits as top-level items, because derivation depends only on the item's own blueprint — the hosting component does not influence it.

## Restore Re-Derivation

When world state is **persisted and restored**, old-format snapshots may contain items that lack material-derived stats. Restore fills in the missing traits.

### Fill-Only Gap-Filling Sync

The restore sync uses a **fill-only** strategy:

- **Persisted `item.traits` keys are the source of truth.** Only keys *missing* from the persisted item are filled from the blueprint ⊕ material-derived computation. Keys already present in the persisted item are **preserved** — never overwritten.
- **Invariant:** "persisted item.traits is the source of truth after restore; derivation is gap-filling only; item traits are not mutated at runtime by other systems."
- **Trade-off:** data re-tuning (e.g., adjusting material formulas) does *not* retroactively change already-persisted items. New items spawned after the tuning pick up the new values on first spawn.
- **Idempotent:** re-running the sync on the same snapshot is safe — all existing keys skip the fill path.
- **Items without materials:** skipped entirely.

### Contract Tests

Full contract coverage for the fill-only behavior lives in [`test/contract/materialTraitsPersistence.contract.test.js`](test/contract/materialTraitsPersistence.contract.test.js).

## Client Display (Implemented)

Material composition is displayed on component cards and item cards as always-visible inline badges with role labels, so players can see what something is made of without opening a detail view. A single badge style is shared across the component and inventory panels rather than duplicated per panel.

## Phase 2 (Deferred)

- Separate `Physical.cutResistance` / `Physical.impactResistance` stats
- Channel-based damage (`resistStat` on `damageComponent`)
- Non-linear material interaction rules (pair-based effects like wet wood, iron rust)
- Per-instance material choice via crafting (`initialOverrides`)
- World map tooltips showing material composition
- More materials: rubber, cloth, plastic, crystal
