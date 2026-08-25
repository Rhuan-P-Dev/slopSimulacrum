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

Each entry defines a raw material's physical properties:

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name (e.g., `"Wood"`, `"Iron"`) |
| `density` | number | Mass per volume unit. Used by the `densityVolume` formula. Units are arbitrary but consistent (wood = 0.6, iron = 7.8) |
| `properties` | object | Key-value pairs on a 0–100 scale. Each key maps to a source property in the derivation table |

Phase 1 properties: `flammability`, `electricalConduction`, `moistureRetention`, `cutResistance`, `impactResistance`, `wearResistance`, `heatConduction`.

### `data/propertyTraitMapping.json`

Defines how blended material properties map to trait stats. Two formula types:

#### `formula: "densityVolume"` — for mass

```
mass = Σ(fraction_i × density_i) × componentVolume
```

Example: knife with `iron 0.6`, `wood 0.4`, `volume: 1`:

```
mass = (0.6 × 7.8 + 0.4 × 0.6) × 1 = 4.92
```

#### `sources: { property: weight, ... }` — for derived stats

```
stat = Σ(sourceProperty_i × weight_i) / Σ(weight_i)
```

Weights are normalized to sum to 1.0. Any subset of properties can be used.

Current mappings:

| Target Trait | Formula | Explanation |
|-------------|---------|-------------|
| `Physical.mass` | `densityVolume` | Physically-consistent mass from density × volume |
| `Physical.durability` | weighted sources | `wearResistance (0.5)`, `impactResistance (0.3)`, `cutResistance (0.2)` |
| `Physical.flammability` | direct mapping | `flammability (1.0)` — material flammability maps 1:1 |

## Derivation Pipeline

```mermaid
flowchart LR
    A[Blueprint materials array] --> B[_validateComposition]
    B --> C[_blendProperties]
    C --> D[_deriveTraits]
    D --> E[Trait-shaped object for mergeTraits]
```

### Step 1: Validation (`_validateComposition`)

- Each material `id` must exist in `materials.json` → throws on unknown
- Each `fraction` must be > 0 → throws on zero/negative
- Sum of all fractions must be ≤ 1.0 → throws if exceeded (fail-fast)

### Step 2: Property Blending (`_blendProperties`)

For each property across all materials in the composition:

```
blendedProperty = Σ(material.fraction × material.properties[property])
```

`density` is handled separately (it's a root-level field, not inside `properties`).

### Step 3: Trait Derivation (`_deriveTraits`)

For each entry in the mapping table:

- **densityVolume**: compute mass from blended density and component volume
- **sources**: compute weighted average of blended source properties

Result: a trait-shaped object like `{ Physical: { mass: 4.92, durability: 45, flammability: 35 } }`.

## Validation Rules

| Rule | Condition | Action |
|------|-----------|--------|
| Malformed registry (ctor) | registry not a plain object / missing required fields | Throw `TypeError` |
| Invalid mapping key (ctor) | key does not match `/^[A-Za-z]+\.[A-Za-z_]+$/` | Throw `TypeError` |
| Unknown material ID | `materials[id]` not found in composition | Throw `TypeError` |
| Zero/negative fraction | `fraction <= 0` | Throw `TypeError` |
| Fraction overflow | `Σ fractions > 1.0` | Throw `TypeError` |

Constructor-time validation runs once at boot: `_validateMaterialsRegistry()` and `_validateMappingRegistry()` throw `TypeError` on malformed data. Startup validation in `WorldComposition.buildWorldState()` calls `validateComposition()` for every component and inventory item blueprint — any defect causes immediate boot failure. Derivation-time validation (`_validateComposition`) throws `TypeError` for per-composition defects.

## Backward Compatibility

Blueprints **without** a `materials` field:

- `MaterialController.derive()` returns `{}` (empty object)
- `TraitsController.mergeTraits()` receives `materialDerived = {}`
- Merge output is **identical** to the pre-material system behavior
- Every existing test stays green — zero regression

## Integration Points

| Component | File | Role |
|-----------|------|------|
| MaterialController | [`src/controllers/materials/MaterialController.js`](src/controllers/materials/MaterialController.js:1) | Pure derivation logic, no facade dependency |
| TraitsController | [`src/controllers/traits/TraitsController.js`](src/controllers/traits/TraitsController.js:45) | Extended `mergeTraits()` to accept `materialDerived` parameter |
| ComponentController | [`src/controllers/core/componentController.js`](src/controllers/core/componentController.js:96) | Calls `derive()` in `initializeComponent()`, passes result to `mergeTraits()` |
| WorldComposition | [`src/composition/WorldComposition.js`](src/composition/WorldComposition.js:130) | Instantiates MaterialController (layer 0), injects into ComponentController |
| InventoryManager | [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js:54) | `_mergeItemTraits()` for item instances; `resyncItemTraits()` for restore re-derivation |

## Item-Instance Material Derivation

Material traits are also derived for **inventory items**, not just components. This enables the "fresh meat" system where items carried by NPCs can be destroyed and dropped as consumable resources.

### Pipeline

```
addItem(itemType, hostComponentId) → InventoryManager._mergeItemTraits()
                                     ↓
                              MaterialController.derive(blueprint)
                                     ↓
                              blueprint.traits overrides merged in
                                     ↓
                              item.traits.Physical populated
```

### `_mergeItemTraits(itemDef)` — InventoryManager helper

Located in [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js:54):

```javascript
_mergeItemTraits(itemDef) {
    const traits = itemDef.traits ? structuredClone(itemDef.traits) : {};

    if (!this._materialController || !Array.isArray(itemDef.materials) || itemDef.materials.length === 0) {
        return traits; // backward-compatible passthrough
    }

    try {
        const derived = this._materialController.derive(itemDef);
        for (const [traitId, stats] of Object.entries(derived)) {
            traits[traitId] = { ...stats, ...(traits[traitId] || {}) }; // blueprint wins
        }
    } catch (error) {
        Logger.warn(`[InventoryManager] Failed to derive material traits for "${itemDef.name}" (${itemDef.type}): ${error.message}. Using raw blueprint traits.`);
    }

    return traits;
}
```

**Key behaviors:**
- **Null controller**: returns a shallow clone of blueprint traits — items without materials registry get raw blueprint traits
- **No/invalid materials field**: `Array.isArray` guard ensures non-array materials are skipped — items like `powerCell` skip derivation entirely
- **try/catch fallback**: derivation failures are logged as warnings and the method falls back to raw blueprint traits (never throws at runtime)
- **Blueprint override wins**: for each trait group, material-derived stats are spread first, then blueprint stats overwrite on conflict
- **Idempotent**: calling `_mergeItemTraits()` twice on the same itemDef produces identical result

### Usage in addItem / addItemToContainer

When an item is added to an entity's inventory:

```javascript
// In addItem():
const traits = this._mergeItemTraits(itemDef);
const newItem = {
    id: generateId(),
    type: itemType,
    volume: itemDef.volume ?? 1,
    traits: traits,  // ← material-derived + blueprint overrides
    holdingCosts: itemDef.holdingCosts ?? {}
};
```

### Container Children

Items inside containers also receive material-derived traits. When `addItemToContainer` is called, the same `_mergeItemTraits(itemDef)` pipeline runs — the host component context does not affect item derivation (items have their own blueprints).

## Restore Re-Derivation (resyncItemTraits)

When world state is **persisted and restored**, old-format snapshots may contain items that lack material-derived stats. The `resyncItemTraits()` method fills in missing traits.

### Pipeline

```
WorldStateController.restore(snapshot)
    ↓
[inventory restore step — items loaded from snapshot]
    ↓
inventoryManager.resyncItemTraits()
    ↓
for each item with .materials: re-derive + merge → update item.traits
```

### `resyncItemTraits()` — fill-only gap-filling sync

Located in [`src/utils/InventoryManager.js`](src/utils/InventoryManager.js:82):

```javascript
resyncItemTraits() {
    if (!this._materialController) return;
    for (const entityId of Object.keys(this._inventory)) {
        const entityInv = this._inventory[entityId];
        if (!entityInv) continue;
        for (const [itemId, item] of Object.entries(entityInv)) {
            if (!item.type) continue;
            const itemDef = this._itemDefinitions[item.type];
            if (!itemDef || !Array.isArray(itemDef.materials) || itemDef.materials.length === 0) continue;
            const derivedTraits = this._mergeItemTraits(itemDef);
            if (!derivedTraits) continue;
            if (!item.traits) item.traits = {};
            for (const [group, stats] of Object.entries(derivedTraits)) {
                if (!item.traits[group] || typeof item.traits[group] !== 'object') item.traits[group] = {};
                for (const [key, value] of Object.entries(stats)) {
                    if (item.traits[group][key] === undefined) item.traits[group][key] = value;
                }
            }
        }
    }
}
```

**Fill-only contract:**

- **Persisted `item.traits` keys are the source of truth.** Only keys *missing* from the persisted item are filled from the blueprint ⊕ material-derived computation. Keys already present in the persisted item are **preserved** — never overwritten.
- **Invariant:** "persisted item.traits is the source of truth after restore; derivation is gap-filling only; item traits are not mutated at runtime by other systems." This contract is enforced by the `=== undefined` guard on every key write.
- **Trade-off:** data re-tuning (e.g., adjusting material formulas) does *not* retroactively change already-persisted items. New items spawned after the tuning pick up the new values on first spawn.
- **Idempotent:** re-running `resyncItemTraits()` on the same snapshot is safe — all existing keys skip the fill path.
- **Items without materials:** skipped entirely.

### Contract Tests

Full contract coverage in [`test/contract/materialTraitsPersistence.contract.test.js`](test/contract/materialTraitsPersistence.contract.test.js):

| Test | Scenario |
|------|----------|
| `fresh-spawn knife items have material-derived mass and flammability` | New items get traits on addItem |
| `restored snapshot retains material-derived traits` | Serialize → restore preserves traits |
| `old-format snapshot gets them after restore via resyncItemTraits` | Tampered snapshot (stripped mass/flammability) gets filled in |
| `getItemStats returns material-derived stats for a knife item` | Frontend stats panel receives correct values |

## Example: Knife Composition

Blueprint (`data/inventoryItems.json`):

```json
{
  "knife": {
    "materials": [
      { "material": "iron", "fraction": 0.6, "role": "blade" },
      { "material": "wood", "fraction": 0.4, "role": "handle" }
    ],
    "traits": {
      "Physical": { "durability": 30, "sharpness": 50 },
      "Manipulation": { "fine_controls": 20 }
    }
  }
}
```

Material-derived stats (before blueprint overrides):

| Stat | Calculation | Value |
|------|-------------|-------|
| `mass` | `(0.6×7.8 + 0.4×0.6) × volume` | ~4.92 (volume=1) |
| `durability` | Weighted blend of wear/impact/cut resistance | ~38 (blueprint overrides to 30) |
| `flammability` | `0.6×5 + 0.4×80` | 35 |

Final stats after merge:

| Stat | Source | Final Value |
|------|--------|-------------|
| `mass` | material-derived | ~4.92 |
| `durability` | blueprint override | 30 |
| `sharpness` | global default | 10 |
| `flammability` | material-derived | 35 |

## Client Display (Implemented)

Material composition is displayed on component cards and item cards as always-visible inline badges with role labels.

### Data Flow

```
data/materials.json → MaterialController.materialsRegistry
data/components.json + inventoryItems.json → compositions (blueprint-level)
                          ↓
         WorldStateController.getMaterialRegistry()
                          ↓
         GET /materials/registry endpoint
                          ↓
         public/js/MaterialRegistry.js (client cache)
                          ↓
         ComponentViewer badges + InventoryManager badges
```

### Registry Endpoint

| Method | Path | Description |
|--------|------|-------------|
| GET | `/materials/registry` | Returns `{ materials, compositions }` |

Response shape:

```json
{
  "materials": {
    "wood": { "name": "Wood", "density": 0.6, "properties": { ... } },
    "iron": { "name": "Iron", "density": 7.8, "properties": { ... } }
  },
  "compositions": {
    "centralBall": [{ "material": "iron", "fraction": 1.0 }],
    "knife": [
      { "material": "iron", "fraction": 0.6, "role": "blade" },
      { "material": "wood", "fraction": 0.4, "role": "handle" }
    ]
  }
}
```

### Client Module: `MaterialRegistry.js`

| Method | Description |
|--------|-------------|
| `load()` | Fetch `/materials/registry` (idempotent — fetches once) |
| `ensureLoaded()` | Convenience wrapper that awaits `load()` if not yet loaded |
| `getComposition(type)` | Returns materials array for a blueprint type, or `null` |
| `getMaterialName(materialId)` | Display name (falls back to raw id) |
| `formatBadge(entry)` | Format: `"Iron 60% (blade)"` |
| `formatBadges(type)` | HTML string of all badge spans for a type |

### UI Rendering

**ComponentViewer** (`public/js/ComponentViewer.js`):
- Calls `await MaterialRegistry.ensureLoaded()` before rendering
- Inserts `<div class="component-materials-row">` between header and stats block
- Uses `MaterialRegistry.formatBadges(comp.type)` to generate badges

**InventoryManager** (`public/js/InventoryManager.js`):
- Imports `MaterialRegistry` module
- Inserts `<div class="inventory-materials-row">` after drag handle in item cards
- Uses `MaterialRegistry.formatBadges(item.type)` to generate badges

### Badge Styling

| Class | Purpose | Location |
|-------|---------|----------|
| `.component-materials-row` | Container row in component cards | `public/css/components.css` |
| `.inventory-materials-row` | Container row in item cards | `public/css/inventory.css` |
| `.material-badge` | Individual badge span with hover effect (shared cross-panel) | `public/css/utilities.css` |

Badges display as: `Iron 60% (blade)` with green border, tooltip showing raw fraction and role. The `.material-badge` class was moved from `components.css` to `utilities.css` so it can be shared across ComponentViewer and Inventory panels without duplication.

## Phase 2 (Deferred)

- Separate `Physical.cutResistance` / `Physical.impactResistance` stats
- Channel-based damage (`resistStat` on `damageComponent`)
- Non-linear material interaction rules (pair-based effects like wet wood, iron rust)
- Per-instance material choice via crafting (`initialOverrides`)
- World map tooltips showing material composition
- More materials: rubber, cloth, plastic, crystal
