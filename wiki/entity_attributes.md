# Entity Attributes — Whole-Entity Stats

**Status:** Implemented and test-pinned. The M1 droid ships with a single
whole-entity attribute, `Physical.energy`, as the reference case. The pattern
generalizes to any blueprint: whole-entity stats are declared in
`data/entity_attributes.json`, seeded at spawn, driven per-turn through a
facade, and — when declared — rendered by the client.

**Further superseded by a data change (pre-ship):** in the *first* shipped
iteration the `coalGenerator` organ was inert (empty `overTime`, empty `grants`),
so no energy mechanic was actually active. This design file describes the
*current* shipped state: the `coalGenerator` is a live fuel burner (one coal
every 5 rounds → +10 energy, clamped at the entity's energy ceiling), and the
entity's whole-entity energy attribute drives its life and death.

**Scope:** the separation between **whole-entity attributes** (owned by the
entity, declared per blueprint in data) and **per-component stats** (owned by
component instances, declared by form/organ in `data/components.json` /
`data/internalComponents.json`). No component-stat code is written here; the
per-component world is owned by [basic_traits_and_stats_spec.md](basic_traits_and_stats_spec.md) and
[energy_flow_spec.md](energy_flow_spec.md).

---

## 1. Core concept

Two distinct "number on a thing" registries coexist, and this feature exists
to keep them from colliding:

| Kind | Owned by | Declared in | Seeded | Written per-turn | Example |
| --- | --- | --- | --- | --- | --- |
| **Whole-entity attribute** | The **entity** (one instance) | `data/entity_attributes.json` (per blueprint) | At spawn, into the entity record (`attributes` + `attributesConfig`) | `EntityEnergyController` (drain) / `InternalComponentController` (charge) | `m1Droid` `Physical.energy` 100/100, −1/turn |
| Per-component stat | A **component instance** | `data/components.json` / `data/internalComponents.json` (organ grants / initial) | By form + organ grants, per component | `ComponentStatsController` / flow / organ effects | a droid's `m1CentralBody` `Physical.energy` (per the old flow) |

The defining rule: **an attribute is a stat of the whole entity and belongs
to the entity**, not to any component. When the M1's energy hits 0 the *entity*
dies (spill + despawn), not a component. This is exactly why the attribute lives
on the entity record (`entity.attributes` / `entity.attributesConfig`) and is
read/written through the entity-side facade API, never through the per-component
stat path.

---

## 2. Data model — `data/entity_attributes.json`

The file is **immutable config**, read once at boot and cached
([src/utils/EntityAttributeData.js](src/utils/EntityAttributeData.js)). Its shape:

```json
{
  "attributes": {
    "m1Droid": {
      "Physical.energy": {
        "value": 100,
        "max": 100,
        "drainPerTurn": 1
      }
    }
  }
}
```

- **Key form.** Each attribute is keyed in the flat `"Group.stat"` wire form
  — identical to the organ-grant key form used by the component system. `Group`
  is a trait-group id (e.g. `Physical`), `stat` is the stat name (e.g.
  `energy`). A split `Group.stat` → `(traitId, statName)` is the single point
  that feeds the setter API, so the two vocabularies stay in lockstep.
- **Three fields per attribute**, each validated (malformed → dropped with a
  warn, never crashes boot):
  - `value` — initial value, seeded at spawn.
  - `max` — hard ceiling. **The single source of truth for the charging ceiling
   **; `setEntityAttributeDelta` clamps every write into `[0, max]`, and the fuel
    burner gates and clamps against the *same* `max` (not a second number in
    `data/internalComponents.json`).
  - `drainPerTurn` — how much the per-turn step subtracts (0 = no drain).

**Missing data → nothing seeded.** An absent/empty file, or a blueprint with no
entry, defaults to `{}` — no attributes, no drain, no generator charging, *no
wasted fuel* (the burner returns early when the entity has no declared
attribute). This preserves the "legacy entities are untouched" invariant.

---

## 3. The energy-life loop (M1 reference)

Data: `m1Droid` → `Physical.energy` = `{ value: 100, max: 100, drainPerTurn: 1 }`.
Data: `coalGenerator` organ (on `m1CentralBody`) → `consumeFuelGenerateStat`
{ `fuelItem: coal`, `fuelConsumedPerInterval: 1`, `intervalTurns: 5`,
`energyGainPerInterval: 10`, `targetStat: Physical.energy` }.

Per round (round-start hook in [WorldComposition.js](src/composition/WorldComposition.js)):

1. **IC fuel burn (L1).** The coal generator checks the host entity's live
   `energy`. Full battery (≥ entity `max`) → skip, burn nothing. Below full with
   coal aboard → consume 1 coal, charge `min(10, max − current)`, clamped. Dry
   (no coal) → log the dry transition **once** per cadence (no spam).
2. **Energy flow (L2).** The per-component network circulation (this design's
   predecessor).
3. **Entity drain + death (L3).** `EntityEnergyController` drains each entity's
   energy by its `drainPerTurn`. After the drain, if the live value hits 0,
   the facade `eliminateEntityByEnergy` runs: **spill all carried contents to the
   floor at the entity's own `location`/`spatial`, then despawn**. Double-
   elimination is safe (the facade no-ops on absent/inactive entities).

Net behavior, pinned by [test/contract/coalGenerator.contract.test.js](test/contract/coalGenerator.contract.test.js):
M1 spawns at 100 energy, drains 1/round, recharges 10/5-rounds via coal; when
coal runs out it drains to 0 and dies — contents spill to the floor **in the
room it occupied**, and the entity is gone.

---

## 4. Controllers and data flow

| Piece | Responsibility | Reads/writes |
| --- | --- | --- |
| [src/utils/EntityAttributeData.js](src/utils/EntityAttributeData.js) | Loads + validates `data/entity_attributes.json`; `getAttributes(blueprint)` → `{ "Group.stat": { value, max, drainPerTurn } }` or `{}`. Immutable, cached. | Read-only on the file |
| [stateEntityController.js](src/controllers/core/stateEntityController.js) | Seeds `attributes` (live) + `attributesConfig` (declaration) on each entity at spawn from the blueprint entry. | Writes entity records |
| [InternalComponentController.js](src/controllers/core/InternalComponentController.js) | `consumeFuelGenerateStat` fuel burner: source-of-truth ceiling check, fuel search, clamp, exhaustion log-once. | Via facade: `getEntityAttribute`/`getEntityAttributeConfig`/`setEntityAttributeDelta` |
| [EntityEnergyController.js](src/controllers/core/EntityEnergyController.js) | Per-round: drain each entity's energy by its `drainPerTurn`; eliminate when 0. Stateless (the attribute *is* the state). No tick dependency — driven from the round-start hook. | Via facade only |
| [WorldStateController.js](src/controllers/WorldStateController.js) | **The facade.** `getEntityAttribute` / `getEntityAttributeConfig` / `setEntityAttributeDelta` (clamps into `[0, max]`, gated broadcast) / `eliminateEntityByEnergy` (spill + despawn). No raw state mutation from outside. | Owns entity records |
| [WorldComposition.js](src/composition/WorldComposition.js) | Composition root. Wires the 3-layer isolation round-start hook (IC → flow → energy). | — |
| Client [public/js/EntityAttributeBars.js](public/js/EntityAttributeBars.js) + [EntityAttributeData.js](public/js/EntityAttributeData.js) | Renders the **whole-entity** attribute bars for the active droid from `attributes`/`attributesConfig` on the broadcast state — distinct from per-component `StatBarsManager`. Data-gated (only declared attributes with a display entry render), low-energy threshold, clamp over-max. | Read-only on state |

**Facade-only contract.** The energy/charge controllers mutate attributes *only*
through `setEntityAttributeDelta` (they never touch raw state or component stats)
and read through `getEntityAttribute*`. The drain/charge happen at round start and
pass `broadcast: false` so the turn's single full-state broadcast (emitted by the
turn system) is the only emit — no per-droid-per-turn redundant full states.

---

## 5. Design invariants

1. **Entity owns the stat.** Whole-entity attributes live on the entity record,
   never on a component instance. Death is an entity event, not a component
   event.
2. **Data-driven balance.** `value`/`max`/`drainPerTurn` live in
   `data/entity_attributes.json`. The controller has no magic numbers. The
   charging ceiling is the attribute's `max` — one number, one place.
3. **Missing data → nothing seeded** (legacy-safe), and the generator burns no
   fuel when there is no attribute to charge (no silent coal loss).
4. **Single broadcast per round.** Round-start attribute writes suppress their
   own broadcast and coalesce into the turn system's one full-state emit.
5. **Safe death.** `eliminateEntityByEnergy` no-ops on absent/inactive entities
   (double-kill safe); spills at the entity's real `location`/`spatial` (never
   a phantom room or the world origin).
6. **Wiki-first.** Code comments cite this doc; this doc does not predate the
   implementation.

---

## 6. Tests

- **Contract** — `test/contract/coalGenerator.contract.test.js`: spawn state
  (organ installed, 10 coal, 100 energy, declaration intact, *component carries
  no* `Physical.energy`), full-battery skip, clamped charge, partial-waste,
  exhaustion log-once, per-turn drain, death (despawn + 1:1 floor spill in the
  entity's room), and double-elimination safety.
- **Client** — `test/unit/EntityAttributeBars.client.test.js`: container binding,
  value/max/fill, low-energy class (≤ 20%), over-max clamp, data-driven display
  gate, empty placeholder.
- **Facade surface** — `test/contract/worldStateController.contract.test.js` pins
  the entity-attribute API and the entity-energy controller.

---

## 7. References

- [basic_traits_and_stats_spec.md](basic_traits_and_stats_spec.md) — trait groups
  and the stat vocabulary (`Physical.energy` already exists, 0–100 scale).
- [energy_flow_spec.md](energy_flow_spec.md) — the per-component circulation
  this design supersedes for the coal-generator path.
- [turn_driven_ic_and_flow_spec.md](turn_driven_ic_and_flow_spec.md) — the
  round-start hook cadence these controllers are driven by.
- [m1_droid_spec.md](m1_droid_spec.md) — the M1 blueprint the reference case
  rides on.
