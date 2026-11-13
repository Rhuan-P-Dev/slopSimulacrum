# Decision: The System gains a live world-operator console

Date: recorded in the change that implements it.

Status: accepted.

## Context

The existing "System" (`system-authoring`, `WorldAuthoringController`) is **judgment-only**:
it reads the live *definitions* (registries) through four tools and **authors a data-only
mod package** (`propose_mod` -> operator clicks Write -> `data/mods/system-<slug>`).
Applying a package swaps *definitions* at the round boundary (`POST /mods/apply`). The
System therefore **cannot touch the running world**: it never mutates a live entity, a
component's stat (e.g. `Physical.existence`), an organ, an item, or a room, and it does
not execute a verb.

The owner asked for the System to **alter the running world in runtime**, e.g.
"make a component of an entity have existence 0." That is a **live instance mutation**,
a capability the existing authoring flow does not have. This change adds it as a **live
operator console** on the same System tab, session, and conversation.

## What the owner decided (before code)

| Dimension | Chosen |
|-----------|--------|
| Scope | **Full operator console** (every live category the facade already supports) |
| Read model | **Live-state read tools** (the System can see entities/components/items/rooms) |
| Authority | **Proposal + confirm click** (the plan executes only on the operator's click) |
| Trust model | **Server intents** (the model proposes `operation` + `params`; the server resolves, validates, executes) |

## Decision

The System is now a **live operator console**. It keeps definition-authoring
(`propose_mod`) and gains a parallel capability: a **plan of live actions**. One
`WorldOperatorService` owns all live logic (reads, validation, execution, description);
`WorldAuthoringController` orchestrates (tools, the per-session plan, `/system/execute`).
`PROMPT_KIND` stays `system-authoring`; `PROMPT_VERSION` bumps (`RP-2`) for the new tools
and the rewritten "what you may do" section.

### 1. A plan, not a write

The session gains a `session.actions` plan (array of server-validated intents). A turn's
model work may call a single new tool `propose_action` (operation + params) repeatedly;
each accepted call **appends** a validated intent to the plan. The plan is returned in
`handleChat` and `getHistory`. A separate click — **POST /system/execute** — executes
the plan and clears it. Definition-authoring (`/system/write`) is *unchanged* and stays
separate, so a mod package (deferred, round-boundary) and a live mutation (immediate)
are two visibly distinct things in the UI and two different HTTP verbs.

### 2. The model proposes, the server executes (SEC-4, B-2)

`propose_action` takes an **operation enum** and free-form `params`. The *server*
(normalisation, `T-1`/`T-2` type-checks, entity/component/item/room/definition existence,
and stat-name checks) turns it into a validated intent. The model never names a facade
method, never builds a path, and never executes — it only proposes an *intent*. The plan
is re-validated **at execute time** (`T-1`): the world may have moved between propose and
execute, and a stale reference (entity despawned, component removed, definition swapped)
fails that action and is reported, while the rest of the plan still runs.

`WorldOperatorService` is a **seamless, dependency-injected, no-LLM** module — every
call reads/executes through the injected `WorldStateController` and `RegistryStore`, so it
is unit-testable without the provider (`B-2`) and without disk (`B-3`).

### 3. The operation menu (the console)

`WorldOperatorService` holds a frozen operation registry. Each operation maps
`params` -> validated intent -> a **facade public method** (or an existing handler) call.
The full set:

- **Entities:** `spawn_entity` (`spawnEntity`), `despawn_entity` (`despawnEntity`),
  `move_entity` (`moveEntity`), `set_entity_stat` (`setEntityAttributeDelta` via a
  read-then-delta), `execute_action` (`executeAction` — a verb, e.g. damage).
- **Components:** `set_component_stat` (new facade `setComponentStat` ->
  `ComponentController.updateComponentStat`), `remove_component`
  (`removeBrokenComponent` — spill + cascade + cleanup + root elimination).
- **Organs (internal components):** `add_organ` (`addInternalComponent`),
  `remove_organ` (`removeInternalComponent`).
- **Items:** `add_item` (`addItemToEntity`), `remove_item` (`removeItemFromEntity`),
  `move_item` (`moveItemInEntity` / `takeItemFromEntity`), `equip_item`,
  `unequip_item`, `wear_item`, `craft_item` (`craftItems`).
- **Machines:** `place_machine` / `retrieve_machine` (the existing
  `handlePlaceMachine` / `handleRetrieveMachine` handlers, as the routes use them).
- **World:** `start_world` (`startWorld`), `stop_world` (`stopWorld`),
  `recreate_world` (`recreateWorld`).
- **The map** (added by
  [`world-structure-authoring.md`](./world-structure-authoring.md)):
  `create_room` (`createRoom` -> `RoomsController.addRoom` + `connectRooms`; `connectFrom`
  is mandatory and the door opens both ways, so nothing is stranded) and
  `spawn_world_object` (`spawnWorldObject` -> the same isStatic spawn `_spawnStaticProps`
  uses at boot, so there is one kind of prop). Both are **memory only**: a restart rebuilds
  the map from the packages, and neither operation ever moves, renames or removes an
  installed room.

### 4. Live reads

Three new tools read the *running* world (the existing `list_registries` /
`read_registry` / `find_definitions` read only *definitions*):

- `list_entities` — bounded list of live entities (id, name, blueprint, room).
- `inspect_entity` — one entity: components (with current stats, incl. existence),
  organs, items, location. This is what lets the model target "this entity's
  `Physical.existence`".
- `list_rooms` — bounded room list, answering with **both** vocabularies a room has (the
  live `id` the world runs on, and the `logicalId` the `rooms` registry reads) plus the
  door names each room has, so a `create_room` proposal can name a target that exists.

The model already reads the *definition* vocabulary (blueprints, item types, internal
component types, recipes, machines, actions, stat names) through the existing registry
tools; the live tools let it see *which* live entities/components/rooms those definitions
instantiate. Both halves are needed for an intent to be precise.

### 5. Immediate, not at the round boundary

`POST /system/execute` mutates the running world **now** (the same synchronous path as
`/move-entity`, `/place-machine`, etc.), not at the round boundary. This is a new
kind of write: the mod path defers to the round boundary by design
(`wiki/decisions/mod-system.md`, decision 4); the live path is immediate by nature.
They stay **two separate verbs** so the two semantics never merge.

### 6. UI

`SystemPanel` gains an **actions card** (the counterpart of the existing proposal card):
each pending action renders its proposed operation plus its (server-validated) params,
with an **Execute** button (POST /system/execute) and a **Clear** button (discard the
plan). Execute returns one line per action — server-generated summary, status, and error
— painted to the transcript. A turn that proposed actions shows the card; a turn that
proposed a *package* shows the existing card. The client stays disposable (`SEC-4`):
every string on the card is server data, written with `textContent`, never model markup.

### 7. Rules it touches

- `SEC-4` — model output is data; the model proposes intents, the server resolves/validates/executes.
- `B-2` — no new provider seam; `WorldOperatorService` never calls the LLM.
- `B-3` — no new disk access; all mutation goes through the facade (in-memory world state).
- `T-1` / `T-2` — every `params` value is parsed + type-checked at the edge and re-checked at execute.
- `SEC-9` — `/system/execute` is rate-limited (it is a world-mutating endpoint).
- `RP-1` / `RP-2` — one prompt kind (`system-authoring`), version bumped.
- `A-7` — the in-memory plan and sessions are bounded (existing `MAX_SESSIONS`/trim);
  plans are cleared on execute and on new-chat.
- The world facade gained exactly one deliberate public method here
  (`setComponentStat`), recorded as a purposeful addition in
  `test/contract/worldStateController.contract.test.js`. The map change added three more
  (`createRoom`, `spawnWorldObject`, `getRoomLogicalId`), each pinned in the same contract
  test and argued for in [`world-structure-authoring.md`](./world-structure-authoring.md).

## What it does NOT do

- It does **not** bypass the round-boundary apply path: a *mod* is still written by
  `/system/write` and applied via `POST /mods/apply`. The console is for **live state**,
  a different kind of change.
- It does **not** add a new provider, a new dependency, a database, or a command channel.
  The model can name only the server-side operation enum; there is no free-form command.
