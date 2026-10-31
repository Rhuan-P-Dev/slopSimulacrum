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
| `requires`    | no       | Mod ids this package's content references definitions from. Absent means "requires nothing". |

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

## Dependencies: `requires`

```json
{ "id": "my-droids", "version": "0.1.0", "content": ["components"], "requires": ["core-materials"] }
```

A `requires` entry is a claim about the content, not a load hint: "my definitions name things
this package provides, and the world cannot be built without them". Two things follow, both
reported rather than guessed at:

- **A package whose requirement is not met contributes nothing.** Not installed, disabled, or
  itself blocked — in every case the dependent is skipped and named in `GET /mods` under
  `blocked` and in `POST /mods/plan`, with the closest break first
  (`requires "core-crafting", which cannot contribute (requires "core-materials", which is
  disabled)`). This is also what makes *deleting* a directory survivable: its dependents drop
  out with a reason instead of shipping content that references definitions nobody provides.
- **`enable` / `disable` refuse what the install cannot honor**, with `409` and a message that
  names the packages involved. Disabling `core-materials` answers
  `cannot disable "core-materials": core-components, … require it - disable those first`;
  enabling a package whose own requirement is off answers `cannot enable "addon": requires
  "core-base", which is disabled`. Unwinding the chain in dependency order always works, and
  each refusal names the next step.

A **cycle is not an error.** `core-components` and `core-internal-components` reference each
other's definitions, and with both installed and enabled both are satisfied. Resolution
starts from "everything is satisfied" and only ever removes, so mutual requires settle the
way they should. A package requiring *itself* is rejected at parse time (`MOD_REQUIRES_SELF`),
because that is the one cycle nothing else can satisfy.

The official set declares exactly the edges the code enforces — each one verified by the
validator that throws and by building the world with the required package off:

| Package                        | Requires                                                              |
| ------------------------------ | --------------------------------------------------------------------- |
| `core-material-damage-types`   | `core-materials`                                                       |
| `core-material-drop-rates`     | `core-materials`                                                       |
| `core-inventory-items`         | `core-materials`                                                       |
| `core-components`              | `core-internal-components`, `core-materials`                          |
| `core-crafting`                | `core-inventory-items`                                                 |
| `core-machines`                | `core-blueprints`, `core-crafting`, `core-inventory-items`             |

What `requires` does **not** cover, stated because it is load-bearing anyway:

- **A registry the world cannot do without at all.** `core-holding-cost` validates its own
  file and refuses to start when it is empty. No package references it, so no `requires` can
  protect it — disabling it is allowed and bricks the boot. This needs a different word
  (`requiredRegistry`, or a self-check at the seam), and it is an open question.
- **References nobody validates.** `internalComponents.hostComponentType` names a component
  type and nothing checks it; entity blueprints name components and the boot tolerates their
  absence. Those edges are real and undeclared, because declaring an edge the code does not
  enforce would make `requires` mean two different things.

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
| POST   | `/mods/apply`     | Ask for the packages on disk to become the world's definition now. A round open → `{ applied: false, pending: true, appliesAt, reason: "ROUND_ACTIVE" }` (a deferral, not a failure). No round open → `{ applied: true, report: { ok, version, swappedKinds, quarantined, mods } }`. |
| GET    | `/mods/:id/files` | The package's own files as they are on disk: `{ id, dir, manifest, files: [{ name, kind, json, content }] }`, `kind` being the registry a JSON file feeds. The "why is my definition quarantined" view. Unknown id → `404`. |

`pending: true` is the normal success answer, not a warning: the change is written to
`data/mods/loadorder.json` and takes effect at the **next round boundary** (`appliesAt`). A
round never has its definition changed underneath it. On a server whose turn loop is stopped
the change stays pending — and the file already says what the next boot will do. Since the
server boots idle (`README §World lifecycle`), that is the ordinary state of a server nobody
has created a world on yet: a change queued from the Mods screen waits, and lands on the
first round of the world you then create.

The paths carry no `/api` prefix: routes are mounted at `/`, same as the rest of the
server (`src/routes/index.js`).

## From the browser (the launcher)

The page opens on a launcher with two entries, and neither of them is a settings drawer
over the game: they are full-screen views. Nothing runs behind them until **Create world**
starts a world; once one is running it keeps running while you are in a screen, and
**Stop world** (the launcher again, reached by clicking the brand) ends it.

- **Mods** — the packages, the live definition and its per-kind counts, what is waiting
  for a boundary, and the four actions (`Rescan`, `Plan`, `Enable`/`Disable`, `Apply now`).
  It reads `GET /mods` and renders; the only thing it computes is the sum of the server's
  own per-kind counts. A row and its status line change together, so the button never says
  the opposite of the line next to it.
- **Create world** — one checkbox per card in `data/cards/`, then `POST /world/create`.
  Everything is selected by default because that is what a world has always meant here;
  an empty selection is allowed and says what it produces (props, nobody in the room).
  On success the page reloads: every client cache belongs to the world that just ended.

`Enter world` removes the cover. Nothing in the client decides what a card is, what a
package contributes, or whether a change can land in the middle of a round - the server
answers all of that, and this client is disposable by design (`README.md`).

## Status — what is and is not built

Built and tested: discovery, manifest validation, narrowing to declared kinds,
field-level merge with a shadowing report, the official set packaged as `core-*`, the
boot path assembling the world from those packages instead of 21 separate file loads, the
non-throwing composition classifier behind the plan's `quarantine` report, the
`loadorder.json` state file (read at boot, so a disabled package does not contribute),
enable / disable applied at the round boundary, package dependencies (`requires`: resolution,
blocked reporting, and the `409` refusals), the eight endpoints above, and the launcher in
the browser (menu, mod manager, card picker for a new world).

Not built:

- **What `requires` cannot say.** Two residues, both in `wiki/decisions/mod-system.md`
  (Open questions): a registry the world cannot do without at all — `core-holding-cost`
  validates its own file and nothing references it, so disabling it is allowed and bricks the
  boot — and references no code validates (`hostComponentType`, entity blueprints naming
  components), which are real edges and deliberately undeclared.
- **Load order over HTTP.** `loadOrder` is read from `data/mods/loadorder.json`; editing
  that file by hand (then `POST /mods/rescan`) is currently the only way to set it.
- **Quarantine at boot.** The classifier exists and the plan uses it; the boot path still
  throws on malformed data instead of booting around it. Switching boot over is the
  change that makes "the world always comes up" true rather than a plan-time property.
