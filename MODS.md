# Mods

The world is data, and that data is packaged. Every registry the simulation reads —
components, items, materials, actions, blueprints, rooms, world rules — arrives as a
**mod package**, and the server reads the shipped content through the same path it uses
for anything you add. The shipped set is `data/mods/core-*/`, listed as `official` by
`GET /mods`.

This file describes what runs today. The last section names what is not built yet.

## What a package is

```
data/mods/
  core-materials/            official content (reserved `core-` prefix)
    mod.json
    materials.json
  my-droids/                 anything else you drop in
    mod.json
    blueprints.json
    components.json
```

A package is one directory under `data/mods/`. Installing is copying that directory in;
`POST /mods/rescan` tells the server to look again. The manifest is required, and every
kind named in it needs its file in the same directory, named `<kind>.json`.

## `mod.json`

| Field         | Required | Meaning |
| ------------- | -------- | ------- |
| `id`          | yes      | Must equal the directory name. The prefix `core-` is reserved for official content: a package outside the official set cannot claim it. |
| `version`     | yes      | A non-empty string. |
| `content`     | yes      | The list of registry kind ids this package provides (see the table below). Each one is read from `<kind>.json` next to the manifest. |
| `description` | no       | Free text, shown by `GET /mods`. |

`official` is **derived** from the `core-` prefix and never read from the manifest, so
third-party content cannot mark itself as shipped with the server.

```json
{
  "id": "my-droids",
  "version": "0.1.0",
  "description": "Adds a Prospector droid and the parts it needs.",
  "content": ["blueprints", "components"]
}
```

## The kind vocabulary

`GET /mods/kinds` returns this list live, with the number of definitions the world holds
for each. Kind ids are inherited from the data files, so the concept and the name do not
always line up — the table is the short version of the surprise.

| Kind                      | File                            | What it holds |
| ------------------------- | ------------------------------- | ------------- |
| `components`              | `components.json`               | Component definitions — the parts entities are built from. |
| `holdingCost`             | `holdingCost.json`              | The model for what carrying volume costs. |
| `internalComponents`      | `internalComponents.json`       | Internal components (organs mounted inside a component). |
| `inventoryItems`          | `inventoryItems.json`           | Items a droid can pick up, wear, equip or lose. |
| `sensitiveParts`          | `sensitiveParts.json`           | Body parts that can be damaged. |
| `traits`                  | `traits.json`                   | Trait flags. |
| `blueprints`              | `blueprints.json`               | Entity blueprints: blueprint id → the components it is built from. |
| `entityAttributes`        | `entityAttributes.json`         | Attribute definitions and their defaults. |
| `npcs`                    | `npcs.json`                     | The LLM-driven NPC roster (personality, objective, per-round budgets) — not generic entities. |
| `materials`               | `materials.json`                | Materials, with density and properties. |
| `materialDamageTypes`     | `materialDamageTypes.json`      | How each material takes damage. |
| `materialDropRates`       | `materialDropRates.json`        | What each material yields when broken up. |
| `propertyTraitMapping`    | `propertyTraitMapping.json`     | Which properties map to which derived stats and flag thresholds. |
| `actions`                 | `actions.json`                  | The verbs of the world: targeting, requirements, consequences. |
| `crafting`                | `crafting.json`                 | Crafting recipes (inputs → outputs). |
| `machines`                | `machines.json`                 | Machine definitions. |
| `synergy`                 | `synergy.json`                  | Per-action synergy bonuses and their caps. |
| `rooms`                   | `rooms.json`                    | Rooms, their geometry and their connections. |
| `world`                   | `world.json`                    | World setup, including the initial spawns. |
| `worldObjects`            | `worldObjects.json`             | Static objects found in rooms. |
| `worldRules`              | `worldRules.json`               | The rules the simulation enforces. |

## How content combines

Mods apply in ascending `loadOrder`; ties break by id, ascending, so the order is always
total. For each top-level key of a registry the **last writer wins**, field by field: a
package that ships only a fragment of a definition patches the definition rather than
replacing it.

`loadOrder` defaults to `1000` for every package, official or not. Two consequences are
worth knowing before you write an override:

- among packages at the default order, a package whose id sorts **after** the one it
  wants to override is the one that wins — `core-` sorts early, so ordinary names
  override it;
- to be explicit, the package needs a `loadOrder` in the per-mod state file,
  `data/mods/loadorder.json`:

  ```json
  { "mods": [ { "id": "deep-geology", "enabled": true, "loadOrder": 500 } ] }
  ```

  Both fields are optional and every entry needs an `id`. The loader narrows it: a field of
  the wrong type is ignored (that entry falls back to its defaults), and a file that is not
  this shape is read as empty. It is user-editable tuning data, so a typo in it must not
  keep the server from starting — but it does take a `POST /mods/rescan`, or a restart, to be
  seen. No endpoint writes `loadOrder`; `enable` / `disable` write only `enabled`.

A package that fails to load does not take the world with it: it is skipped by name,
with a code and a message, and reported in `invalid` by both `GET /mods` and
`POST /mods/plan`. The remaining packages load. Codes: `MOD_MANIFEST_MISSING`,
`MOD_MANIFEST_INVALID`, `MOD_ID_INVALID`, `MOD_ID_DIR_MISMATCH`,
`MOD_CONTENT_KIND_UNKNOWN`, `MOD_CONTENT_UNREADABLE`.

## Quarantine: definitions the world will not hold

Some definitions are refused by the world's own composition rules — material fractions
that exceed one, a material that does not exist, a recipe whose output item is not
defined, a machine bound to a blueprint, item or recipe that is missing. Those rules live
with their owners (`MaterialController`, `CraftingController`, `MachineRegistryController`)
and the plan runs them through `CompositionClassifier`, reporting one entry per definition
with the owner's own message.

Two things follow, and both are deliberate:

- **The chain runs downstream.** A recipe is checked against the items that survived, a
  machine against the recipes that survived. Quarantine a material and everything built on
  it is named in order, each with the reason it fell.
- **A broken material family is reported once**, as a registry-scope entry naming the
  registries involved — not as a quarantine notice for every component in the game. With
  no trustworthy base there is no component-level verdict to give.

`POST /mods/plan` returns these under `quarantine`; the `kinds` diff lists only what would
actually install, so a definition appears in one or the other, never both.

Today the classifier feeds the **plan only**. The boot path still validates fail-fast: a
malformed official file stops the server rather than booting a world with holes in it.

## HTTP surface

| Method | Path              | What it does |
| ------ | ----------------- | ------------ |
| GET    | `/mods`           | Installed packages (id, version, official, enabled, loadOrder, content kinds), rejected packages, and the definition counts the world is running. |
| GET    | `/mods/kinds`     | The vocabulary a `content` array is written in, with the file behind each kind and how many definitions of it are live. |
| POST   | `/mods/rescan`    | Read the package directory again. Installs nothing. |
| POST   | `/mods/plan`      | What an apply would change, per kind: added, removed and changed definition names, who provides each, what is shadowed. Mutates nothing; `applied` is always `false`. |
| POST   | `/mods/:id/enable`  | Enable an installed package. `{ success, id, enabled, pending, appliesAt }`. Rate limited (it writes a file). |
| POST   | `/mods/:id/disable` | Disable an installed package; same envelope. Idempotent. Unknown id → `404 MOD_NOT_FOUND`. |

`pending: true` is the normal success answer, not a warning: the change is written to
`data/mods/loadorder.json` and takes effect at the **next round boundary** (`appliesAt`). A
round never has its definition changed underneath it. On a server whose turn loop is stopped
the change stays pending — and the file already says what the next boot will do.

The paths carry no `/api` prefix: routes are mounted at `/`, same as the rest of the
server (`src/routes/index.js`).

## Status — what is and is not built

Built and tested: discovery, manifest validation, narrowing to declared kinds,
field-level merge with a shadowing report, the official set packaged as `core-*`, the
boot path assembling the world from those packages instead of 21 separate file loads, the
non-throwing composition classifier behind the plan's `quarantine` report, the
`loadorder.json` state file (read at boot, so a disabled package does not contribute),
enable / disable applied at the round boundary, and the six endpoints above.

Not built:

- **Cross-package dependencies.** Packages are not independent and the store does not know
  it: disabling `core-materials` yields an empty-but-valid `materials` registry that the
  store accepts, and the world then refuses the result (`MaterialController` rejects a
  damage type whose material is gone). The rules exist, but they are cross-kind references
  checked in owners' constructors, which the classifier does not walk. See
  `wiki/decisions/mod-system.md` → Open questions for the readings on the table.
- **Load order over HTTP.** `loadOrder` is read from `data/mods/loadorder.json`; editing
  that file by hand (then `POST /mods/rescan`) is currently the only way to set it.
- **Quarantine at boot.** The classifier exists and the plan uses it; the boot path still
  throws on malformed data instead of booting around it. Switching boot over is the
  change that makes "the world always comes up" true rather than a plan-time property.
