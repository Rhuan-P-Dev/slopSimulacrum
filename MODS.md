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
- to be explicit, the package needs a `loadOrder` in the per-mod state file. The loader
  accepts that state (`{ id: { enabled, loadOrder } }`) and there is **no endpoint or
  file reader for it yet** — see the status below.

A package that fails to load does not take the world with it: it is skipped by name,
with a code and a message, and reported in `invalid` by both `GET /mods` and
`POST /mods/plan`. The remaining packages load. Codes: `MOD_MANIFEST_MISSING`,
`MOD_MANIFEST_INVALID`, `MOD_ID_INVALID`, `MOD_ID_DIR_MISMATCH`,
`MOD_CONTENT_KIND_UNKNOWN`, `MOD_CONTENT_UNREADABLE`.

## HTTP surface

| Method | Path              | What it does |
| ------ | ----------------- | ------------ |
| GET    | `/mods`           | Installed packages (id, version, official, enabled, loadOrder, content kinds), rejected packages, and the definition counts the world is running. |
| GET    | `/mods/kinds`     | The vocabulary a `content` array is written in, with the file behind each kind and how many definitions of it are live. |
| POST   | `/mods/rescan`    | Read the package directory again. Installs nothing. |
| POST   | `/mods/plan`      | What an apply would change, per kind: added, removed and changed definition names, who provides each, what is shadowed. Mutates nothing; `applied` is always `false`. |

The paths carry no `/api` prefix: routes are mounted at `/`, same as the rest of the
server (`src/routes/index.js`).

## Status — what is and is not built

Built and tested: discovery, manifest validation, narrowing to declared kinds,
field-level merge with a shadowing report, the official set packaged as `core-*`, the
boot path assembling the world from those packages instead of 21 separate file loads, and
the four endpoints above.

Not built:

- **Apply.** Nothing swaps the running world's definition. A package on disk becomes
  part of the world at the next boot; `POST /mods/plan` shows what an apply would do.
- **Enable/disable and load order over HTTP.** `GET /mods` reports `enabled: true` for
  every package because nothing can set it to false yet.
- **Quarantine.** A mod whose definition references a component that does not exist is
  reported by the plan's diff, not removed from the world.
