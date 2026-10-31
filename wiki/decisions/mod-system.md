# Decision: Data-only mod packages, addable at runtime, with shipped content as official mods

Date: 2026-10-31 (decision record only; no code in this change)

Status: accepted. Implementation is the next change (see "Next change" at the end).

## Context

`slopSimulacrum` is a persistent, data-driven world simulation. Every rule of the world
lives in JSON under `data/` and is read through the data seam (`CR B-3`).

What the repository actually does today (measured, not assumed):

- **The world definition is loaded once, at boot.** `buildWorldState()` in
  `src/composition/WorldComposition.js:146-223` calls `DataLoader.loadJsonSafe()` for each
  registry and injects the parsed objects into the sub-controllers.
- **Registries are captured by reference, not looked up.** Six controllers alone capture
  `actionRegistry` at construction (`WorldComposition.js:293`, `297`, `313`, `325`, `327`,
  `329` -> `ComponentCapabilityController`, `SynergyController`, `ActionController`,
  `LlmContextController`, `HintController`, `InstinctController`). `KnowledgeController`
  goes further and pre-assembles its codex in its constructor
  (`src/controllers/knowledge/KnowledgeController.js:102-128`), so it never sees a data
  change again. Some readers *do* re-read per call (`src/routes/worldRoutes.js:55`,
  `src/routes/internalComponentRoutes.js:28`), which is why freshness is inconsistent today.
- **21 committed data files** carry the shipped world. **49 code references** to those
  literal paths live in `src/` (~24 files) and **89** in `test/` (57 files). The remaining
  hits are doc comments.
- **Boot validation is fail-fast.** 41 throws across `MaterialController`,
  `MachineRegistryController` and `CraftingController`, plus the composition-root pass at
  `WorldComposition.js:196-206`. `validateComposition` is pinned by
  `test/unit/MaterialController.test.js` (4 assertions), and `buildWorldState` is exercised
  by ten-plus unit tests that assume the whole base set is present.
- **Behavior is already a closed data vocabulary.** `data/systems/actions.json` expresses
  effects as typed consequence ops (`deltaSpatial`, `log`, `updateComponentStatDelta`, ...)
  with expression binding (`":Movement.move*2"`), and `data/world/world_rules.json` is a
  data rule layer that degrades "off, never crash".
- **Runtime content already has one precedent**: drop a PNG into `data/cards/` and it
  becomes a droid (`src/controllers/logic/CardSpawnLogic.js`), the filesystem listing being
  the source of truth. Runtime *writes* also have a precedent: `AgentBodyController` backs
  up (`DataLoader.copyFile`) then atomically replaces `data/components/components.json`
  and `data/entities/blueprints.json` (`AgentBodyController.js:319-325`).
- **There is no code-execution surface, by documented design.** No `vm`, no
  `child_process`, no dynamic `import()`, and `shared/RangeResolver.js:28` states that
  `eval`, `Function()` and `setTimeout(string)` are never used.
- **The persistence snapshot (`PERSISTENCE_SCHEMA_VERSION = 3`) stores no static data.**
  Saved entities reference registry keys by name (`src/controllers/logic/PersistenceLogic.js`),
  so any definition that disappears leaves dangling references behind.
- **`check:lang` walks `data/`.** `SKIP_DIRS` in `scripts/check-pt.mjs:32` does not contain
  `data`, and only `data/cards/*` is in `.gitignore`.

Owner requirement: mods (in the sense of Skyrim / RimWorld content packages) must be
**addable at runtime**, not at build time.

## Decision

Seven decisions were taken. Each one is recorded with the rule it touches.

### 1. A mod is data only. No code.

A mod is a directory of JSON fragments in the shapes the existing registries already use.
No `import()`, no scripts, no sandbox, no new runtime dependency (`SEC-8`).

Mods express behavior through the vocabulary that already exists: consequence types,
requirements, world rules, triggers, recipes, materials, components, blueprints, items,
rooms, NPCs. A mod can *compose* mechanics; it cannot invent a new mechanic. Adding a new
consequence type is a core change, and stays one.

### 2. The shipped content becomes 21 official mods, physically relocated.

One official mod per current data file. The mod id is a kebab-case slug with a reserved
`core-` prefix; the file keeps its current basename inside the mod directory, so the
mapping is mechanical and `git mv` is reviewable:

| Mod id | Current path | New path |
| --- | --- | --- |
| `core-components` | `data/components/components.json` | `data/mods/core-components/components.json` |
| `core-holding-cost` | `data/components/holdingCost.json` | `data/mods/core-holding-cost/holdingCost.json` |
| `core-internal-components` | `data/components/internalComponents.json` | `data/mods/core-internal-components/internalComponents.json` |
| `core-inventory-items` | `data/components/inventoryItems.json` | `data/mods/core-inventory-items/inventoryItems.json` |
| `core-sensitive-parts` | `data/components/sensitiveParts.json` | `data/mods/core-sensitive-parts/sensitiveParts.json` |
| `core-traits` | `data/components/traits.json` | `data/mods/core-traits/traits.json` |
| `core-blueprints` | `data/entities/blueprints.json` | `data/mods/core-blueprints/blueprints.json` |
| `core-entity-attributes` | `data/entities/entity_attributes.json` | `data/mods/core-entity-attributes/entity_attributes.json` |
| `core-npcs` | `data/entities/npcs.json` | `data/mods/core-npcs/npcs.json` |
| `core-materials` | `data/materials/materials.json` | `data/mods/core-materials/materials.json` |
| `core-material-damage-types` | `data/materials/materialDamageTypes.json` | `data/mods/core-material-damage-types/materialDamageTypes.json` |
| `core-material-drop-rates` | `data/materials/materialDropRates.json` | `data/mods/core-material-drop-rates/materialDropRates.json` |
| `core-property-trait-mapping` | `data/materials/propertyTraitMapping.json` | `data/mods/core-property-trait-mapping/propertyTraitMapping.json` |
| `core-actions` | `data/systems/actions.json` | `data/mods/core-actions/actions.json` |
| `core-crafting` | `data/systems/crafting.json` | `data/mods/core-crafting/crafting.json` |
| `core-machines` | `data/systems/machines.json` | `data/mods/core-machines/machines.json` |
| `core-synergy` | `data/systems/synergy.json` | `data/mods/core-synergy/synergy.json` |
| `core-rooms` | `data/world/rooms.json` | `data/mods/core-rooms/rooms.json` |
| `core-world` | `data/world/world.json` | `data/mods/core-world/world.json` |
| `core-world-objects` | `data/world/worldObjects.json` | `data/mods/core-world-objects/worldObjects.json` |
| `core-world-rules` | `data/world/world_rules.json` | `data/mods/core-world-rules/world_rules.json` |

Each mod directory carries a `mod.json` manifest:

```json
{
  "id": "core-actions",
  "official": true,
  "version": "1.0.0",
  "engine": { "minSchema": 1 },
  "loadOrder": 100,
  "content": { "actions": "actions.json" }
}
```

`official: true` is derived from the reserved `core-` prefix by the loader, never trusted
from the file, so a user mod cannot claim to be shipped content (`T-1`, `SEC-7`).

**Write targets move with the files.** `AgentBodyController`'s `COMPONENTS_FILE` and
`BLUEPRINTS_FILE` (`AgentBodyController.js:68-69`) point at the new core paths, and so does
its backup path scheme.

### 3. Registry kinds replace path literals; a `RegistryStore` owns the swap.

Relocating 21 files under 49 source call sites only makes sense if the call sites stop
naming paths at all. They do:

- `shared/RegistryKinds.js` (new, pure constants, same shape as `shared/IdPrefixes.js` and
  `shared/ActionVocabulary.js`) enumerates the registry kinds and the content-file key each
  mod uses.
- `src/services/RegistryStore.js` (new) holds one immutable snapshot per kind plus a
  `version`, and exposes `read(kind)` / `snapshot()` / `replace(candidate)`. The controllers
  read through the store instead of capturing a plain object.
- The 49 `src/` references become kind lookups. The 89 `test/` references follow.

This is the one structural change that requirement "addable at runtime" forces. Without it
a swap is half-applied: the six `actionRegistry` capture sites and the constructor-assembled
`KnowledgeController` would keep serving the old world while the routes served the new one.

### 4. Apply is build-validate-swap, at the round boundary.

```
read manifests -> order -> build candidate registries -> validate candidate
  -> (ok)   swap at the round boundary, then rescan + reassemble + broadcast
  -> (fail) reject with a report; the live world is untouched
```

- **Ordering**: `data/mods/loadorder.json`, ascending `loadOrder`, ties broken by id so the
  order is total and deterministic (`D-*`).
- **Validation**: the same validators the boot path uses today, run against the *candidate*,
  before anything is mutated.
- **Swap point**: `TurnSystemController._roundStart()`. Never during the PLANNING enqueue
  window and never mid-`_resolveRound()` (`shared/TurnPhases.js`), so no in-flight action
  sees its definition change underneath it.
- **After the swap** (this is not optional, it is what makes the swap real): re-run the
  capability scan (the existing `POST /api/refresh-entity-capabilities` is the precedent),
  re-assemble `KnowledgeController`, rebuild the machine and crafting cross-checks, then
  broadcast full state (`H-6`).
- The swap is one atomic step per kind set, never per file (`P-3`).

### 5. Override is load-order, per key, deep merge.

Mods apply in `loadOrder` ascending; for each top-level key of a registry, the last writer
wins, and the merge is a field-level deep merge of what the mod actually declares. To nerf
the knife, a mod ships `components.json` with `{"knife": {"materials": {...}}}` and nothing
else. This is the Skyrim / RimWorld semantic the owner asked for, and it needs no new patch
language (`T-3` argues against an optional-field soup; a patch-op language would be a second
format to validate and test).

Shadowing is reported, never silent: the plan endpoint lists every key a mod overwrites and
which mod it came from.

### 6. Official mods are individually disableable, with no restriction. Broken references become quarantine, not a crash.

Any mod, official included, can be disabled. The system does not refuse the request and
does not auto-re-enable anything.

Consequently the validation model splits into two classes of failure, and this is the
largest single change in the whole design:

| Failure | Today | Under this decision |
| --- | --- | --- |
| Malformed definition (bad shape, materials not summing to 1) | throw, boot fails | quarantine that one definition, `warn` (`OBS-4`), listed in the mod report |
| Missing dependency (component material disabled, machine recipe gone) | throw, boot fails | quarantine the referencing definition, `warn`, listed in the report |

The world always boots. A disabled official mod costs exactly the definitions that depended
on it, and `GET /api/mods/:id/report` names them.

Discipline that keeps this from rotting into `AP-3` (catch, log, return default):

- `validateComposition` keeps its throwing contract, so the four pinned assertions in
  `test/unit/MaterialController.test.js` stay true. The mod pipeline calls a new
  non-throwing classifier (`classifyComposition`) that returns `{ valid, quarantined[] }`.
  The boot path uses the classifier too, which is the point: the base set being complete is
  now an *outcome*, not a precondition.
- Quarantine is per definition and always reported with a reason. Never per registry, never
  silent, never a `{}` default.
- Live entities are not destroyed. Quarantining a definition does not invoke
  `RemovalCascadeLogic`; entity instances keep their data and simply stop resolving
  capabilities until the definition returns (`P-7`: soft, do not destroy).

### 7. State lives in `data/mods/loadorder.json`, gitignored; the save records the mod set.

```json
{
  "version": 1,
  "mods": [{ "id": "core-actions", "enabled": true, "loadOrder": 100 }]
}
```

Written atomically through the data seam (`P-3`), and written by the enable/disable endpoints
only.

- The world snapshot gains an **optional** `mods` section (the enabled ids with their
  versions). `PERSISTENCE_SCHEMA_VERSION` stays at `3` because the change is additive
  (`H-1`, `P-2`).
- A save whose recorded set differs from the live set **warns and loads**, consistent with
  decision 6. Absent section = a pre-mod save = load with the current set, warned.
- **`.gitignore` needs the negation, and this is the subtle part.** User mod content must
  stay out of the language gate (`AGENTS.md`: user-authored world content is never
  filtered), but the 21 official mods must stay *in* the repository, and `check:lang` walks
  `data/`. So: ignore `data/mods/*` and un-ignore `!data/mods/core-*/`. `data/mods/` itself
  must not be excluded, or the negation cannot apply.

### Surface

Declared in `src/routes/index.js` like every other route (`H-5`), behind the existing
`authMiddleware` gate, with the write endpoints rate limited (`SEC-2`) and every error in
the machine-readable shape of `H-2`:

| Route | Purpose |
| --- | --- |
| `GET /api/mods` | list: id, official, enabled, loadOrder, version, content kinds, definition counts |
| `POST /api/mods/rescan` | re-read discovery in `data/mods/` only; applies nothing |
| `POST /api/mods/plan` | dry run: candidate diff, shadowing report, quarantine report; mutates nothing |
| `POST /api/mods/:id/enable` | queue the enable at the next round boundary (idempotent by state, `H-3`) |
| `POST /api/mods/:id/disable` | queue the disable at the next round boundary (idempotent by state) |
| `GET /api/mods/:id/report` | current quarantine and shadowing for that mod |

`MOD_NOT_FOUND`, `MOD_MANIFEST_INVALID`, `MOD_RESERVED_ID`, `MOD_PATH_ESCAPE`,
`MOD_CONTENT_KIND_UNKNOWN` and `MOD_SET_MISMATCH` are the stable codes.

Discovery and every path built from a mod id goes through `path.resolve` plus a
`startsWith(baseDir + path.sep)` check (`SEC-7`). Manifest fields are narrowed once at the
loader edge and never re-checked downstream (`T-1`, `T-2`). Filesystem access lives in the
data seam: either new `DataLoader` methods (`listDir`, `readText`), or a seam entry added to
`DATA_SEAM_FS_FILES` in `eslint.config.js` in the same commit as its fixture and its pin
(`B-3b`, "Enforcement is itself tested").

## Consequences

**What this buys**

- Runtime add, enable, disable and update of world content, with no restart and no new
  dependency (`SEC-8`).
- The shipped world stops being a privileged case: it goes through the same loader, so the
  mod path cannot silently drift from the supported path (dogfooding).
- The `RegistryStore` indirection fixes an existing latent inconsistency (boot-captured
  registries versus per-request re-reads) rather than adding a second way to read data.
- Behavior stays reviewable as data: a diff of a mod is a diff of JSON.
- Nerfing shipped content is possible without forking the file.

**What this costs** (accepted, in the owner's words, with the cost stated)

- **Boot is no longer fail-fast.** A broken or incomplete world definition now boots with a
  quarantine report instead of refusing to start. The failure moves from "loud at boot,
  world never wrong" to "quiet at boot, world partial, report must be read". Mitigated by
  the report endpoint, the `warn` lines, and the plan/dry-run endpoint.
- **Disabling `core-components`, `core-materials`, `core-traits` or `core-world` empties the
  world.** Nearly everything references them, and the quarantine report is what makes that
  visible rather than mysterious. Nothing prevents the operation.
- **Dangling references across a save are expected, not exceptional.** A save made with a mod
  enabled and restored without it keeps instances whose definitions are gone. They occupy
  space and resolve nothing until the mod returns.
- **One move, 21 files, 49 `src/` sites, 89 `test/` sites**, plus the two `AgentBodyController`
  write targets and their backups. It is mechanical, but it is not small, and every path
  literal that survives the move is a bug.
- **`rooms.json` is special.** The room *structure* is deliberately not snapshotted
  (`PersistenceLogic`), so disabling `core-rooms` while entities stand in those rooms leaves
  live spatial state with no definition. Recorded here because nothing in the design prevents it.
- **`shared/StatVocabulary.js` says data files must match the vocabulary, never the other
  way around.** Under this decision a mod declaring a stat name that is not in the
  vocabulary is a **manifest validation error**, so mods can compose new content out of
  existing stats but cannot mint stat names. Loosening that is a separate decision.
- **The turn system gains a duty.** Applying at `_roundStart()` is a new responsibility on a
  file already 1699 lines (`CHG-3`); the apply logic itself belongs in its own module, with
  the turn system only calling it.

**Deliberately not handled here**

- Mod-to-mod dependencies (`requires`) - the manifest field is not defined in v1.
- Binary assets in mods (textures, audio, images) - no content kind for them in v1.
- Signing, provenance or trust tiers for mods. All mod JSON is untrusted input and is
  treated as such (`SEC-2`, `SEC-7`, `P-5`); it is never executed, and never interpolated
  into a path, a shell command or a prompt without the edge narrowing.
- A client UI for the mod list (the dev-tab pattern of `AgentBodyPanel.js` is the obvious
  next step, not part of this decision).

## Rejected alternatives

- **JS plugin mods via dynamic `import()`.** Rejected on a hard technical fact, not on
  taste: ES modules are cached permanently, so a code mod can be *added* at runtime but
  never removed or updated in a running process. That breaks the symmetric half of the
  requirement. It would also be the first code-execution surface in a repository that
  documents the opposite invariant (`shared/RangeResolver.js:28`), and would hand any mod
  write access to the world state and to `DataLoader`.
- **Code mods isolated in one Worker per mod.** The only way to make code mods removable, and
  the reason it stays rejected for v1 is cost: every hook becomes an IPC message, the mod
  API must be versioned and frozen before anyone writes a mod, and the debug story for a
  world state split across threads is much worse. Revisit if data-only mods hit a wall.
- **Official mods kept as virtual list entries over the current paths.** Cheaper (zero
  file moves, 138 references untouched) and reversible, but it leaves two data-source paths
  forever - one hardcoded for the base and one real for mods - which is exactly where the
  mod loader would drift. The owner chose the physical relocation.
- **Official mods as one single `core` entry, or per domain folder, or curated gameplay
  packs.** Per-file granularity was chosen: no hand-partitioning of keys. Curated packs
  (`core:clothes`, `core:machines`) read better in a UI but force a permanent curatorship
  question (a component used by both clothes and machines belongs to which pack?).
- **Refusing to disable an official mod, or refusing the disable while any reference is
  pending.** The rejected-with-a-reason option: it protects the boot invariants at the cost
  of making the official list non-editable, which is what the owner wanted to be able to do.
- **Refusing to boot when the enabled set is incomplete.** Keeps all 41 throws and every
  pinned test, but leaves the server unbootable until a human re-enables something, which
  converts a content mistake into downtime.
- **Auto-re-enabling a mod that a dangling reference needs.** Rejected: it makes the disable
  a suggestion, so the control the owner asked for would not exist.
- **Namespaced append-only content (`modid:knife`).** No conflicts possible and trivial
  rollback, but it makes "nerf the shipped knife" impossible, which is the commonest thing
  a mod author asks for.
- **Explicit patch ops (`{op: 'replace', path: ...}`).** Auditable and diff-legible, but it
  is a second format to document, validate and test, and deep merge already covers the
  common case.
- **Whole-file replacement as the override unit.** Two mods editing different items of the
  same domain would erase each other, and every mod author would have to ship the base file.
- **`fs.watch` on `data/mods/` for automatic apply.** Rejected: it can fire mid-copy on a
  half-written mod, and it applies without the explicit plan/validate step. Discovery is a
  call, not an event.
- **Pulling mods from a URL.** Rejected for now: it is SSRF surface (`SEC-3`) plus a supply
  chain question, and the requirement was runtime add, not distribution.

## Implemented so far

Steps 1 to 3 are in `main`, each landed with `npm run check` green. What they changed,
and the four points the loader settled that this document had left open:

- **Kind vocabulary and store** (`shared/RegistryKinds.js`, `src/services/RegistryStore.js`).
  One holder per kind, `read(kind)`, `version()`, `replace(candidate)`. The holder identity
  never changes; `replace()` writes contents in one step, so a construction-time reader
  observes a swap without knowing about it.
- **No path literals left in `src/`.** Readers ask `DataLoader.loadRegistry(kind)`; the one
  kind-to-file table lives in the seam (`REGISTRY_SOURCE_PATHS`). The composition injects the
  store's holders, the self-loading stores take the store, `ComponentNaming` and
  `EntityAttributeData` take it through `setRegistries()`, and the facade gained
  `getRegistry(kind)` for call-time readers (its pinned public surface grew by one,
  deliberately). The two derived caches (sensitivity table, recipe names) key on
  `version()`. A test in `test/unit/RegistryStore.test.js` proves the propagation through the
  real composition: same holder, swap lands, disabling a kind does not fall back to the file.
- **`ModLoader`** (`src/services/ModLoader.js`): discovery in `data/mods/`, manifest
  narrowing, load-order merge, shadowing report. It computes a candidate and touches nothing.

The loader's open points, now decisions:

1. **A manifest's `id` must equal its directory name.** Paths are therefore never built from
   untrusted content (`SEC-7`), and two packages cannot claim one identity - so there is no
   duplicate-id guard, because there is nothing for one to catch.
2. **`content` is a list of registry kinds**, and the content file is `<kind>.json` inside the
   mod directory. A manifest never names a file, which closes the escape surface entirely
   rather than validating an untrusted path.
3. **`official` is never read from a manifest.** It is derived from the reserved `core-`
   prefix. A third-party package declaring `official: true` is simply not official.
4. **A broken mod is reported, not thrown.** Malformed manifest, unreadable or non-object
   content file: that mod contributes nothing and is named in `invalid[]`; the rest still
   build. This is decision 6 applied at the package level, one step above definition-level
   quarantine (step 5).

The seam grew by one method (`DataLoader.listDir`) rather than by a new entry in
`DATA_SEAM_FS_FILES`, so `fs` stays in one file and the lint allowlist is unchanged.

## Next change (when the owner asks for it)

Ordered so each step leaves `npm run check` green. `CHG-7`: steps 2 and 5 are
behavior-bearing and get a test pinning the current behavior first.

1. Done. `shared/RegistryKinds.js` + `RegistryStore`, built by the composition root, behavior
   bit-identical.
2. Done for `src/` (no path literal left, and readers are on the live definition). The `test/`
   references that name paths still work because the shipped files have not moved yet; they
   follow step 4.
3. Partly done. `ModLoader` ships (discovery, narrowing, merge, shadowing). Still missing from
   this step: the `data/mods/*` gitignore with the `!data/mods/core-*/` negation - it lands
   with step 4, since there is nothing in `data/mods/` until the files move.
4. `git mv` the 21 files, add the 21 manifests, add `data/mods/loadorder.json`. Move the
   `AgentBodyController` write targets and their backups.
5. `classifyComposition` beside the existing `validateComposition`; composition root and mod
   pipeline both use it. Old asserts stay, new quarantine tests ship.
6. `GET /api/mods` + `POST /api/mods/rescan` (read-only, no apply).
7. `POST /api/mods/plan` (candidate build, shadowing, quarantine).
8. Enable / disable, apply at `_roundStart()`, rescan, reassemble, broadcast. Snapshot
   `mods` section and the mismatch warning.
9. A fixture mod (`test/`) proving: add a component plus item plus action at runtime, enable
   it, see the capability appear; disable it, see the quarantine report name the dependents
   and the live instance survive.

Verification for the whole change: `npm run check` (lint + `check:lang` + tests), plus a real
`POST /api/mods/plan` and `POST /api/mods/:id/enable` against a running server, watched over
Socket.IO, per the Definition of done.

## Rule touchpoints

`CR B-3` / `CR B-3b` (data seam, how it may be extended), `CR SEC-8` (no new runtime
dependency), `CR SEC-2` / `CR SEC-7` (limits, path containment), `CR T-1` / `CR T-2` /
`CR T-3` (narrow the manifest once at the edge), `CR P-1` / `CR P-2` / `CR P-3` / `CR P-7`
(versioned data, atomic writes, soft deletes), `CR H-1` / `CR H-2` / `CR H-3` / `CR H-5` /
`CR H-6` (additive API, error shape, idempotency, one route table, socket contract),
`CR CHG-3` / `CR CHG-7` (size, refactor under tests), `CR OBS-4` (quarantine is `warn`, not
`error`), `CR D-*` (total deterministic ordering), `CR AP-3` / `CR AP-6` (no silent default,
no mutable global - the store owns the swap), `CR NAME-1` (everything in this tree stays
English ASCII).
