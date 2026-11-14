# Decision: The map is authorable -- rooms and world objects, as a package and live

Amends `wiki/decisions/system-authoring.md`, decision 1 ("The System authors content, never
the map"), and extends `wiki/decisions/system-live-operator.md`, section 3 (the operation
menu). That note's own "Next change" list predicted this one; it said the map would need a
plan-and-preview step the proposal shape did not have. It did not: the plan step already
existed in two places, and the preview is the rule list.

## Context

The owner asked for the System to be able to create `rooms` and `worldObjects`, both as
packages and at runtime. Reading the code first turned the ask into four separate questions,
because the two registries and the two levers behave differently:

- **`worldObjects` already had a package path.** A prop entry (`{ name, blueprint, room,
  position }`) is materialised by `WorldStateController._spawnStaticProps()`, which runs
  inside `initializeWorld()` -- at boot **and** at `POST /world/create`. So authoring props
  into a package already worked; the registry was simply refused at the proposal.
- **`rooms` did not.** `RoomsController` builds every room in its constructor: one generated
  `crypto.randomUUID()` per logical key, connections resolved to those uids, and nothing after
  that. `RegistryStore.replace()` changes the *definition*; no code rebuilt the map. An
  authored room in an applied package therefore became a room at the next **process start**,
  not at the swap -- and `recreateWorld()` deliberately preserves the map ("WHY the map
  survives", `WorldRecreateLogic`), so even a new world on the same process kept the old one.
- **The uid is load-bearing.** Every entity's `location`, every broadcast, the door geometry
  and the round's prose name a room by that generated uid. Rebuilding `RoomsController` would
  mint new uids and orphan every actor standing anywhere.
- **No rule caught a bad room at the boundary.** `CompositionClassifier` classified
  `rooms`/`worldObjects` not at all, and `RoomsController._validateRoomDefinitions` **throws**:
  a malformed room in a package is a crash at the next boot. Letting a model author rooms
  without a candidate rule would have meant "a chat can brick the server".

The four answers the owner gave, before code:

| Question | Answer |
| --- | --- |
| When does an authored room become a room of the live map? | At the swap, additively |
| Do runtime rooms and props persist? | No -- memory only; the package is what persists |
| Which of the world family becomes authorable? | `rooms` and `worldObjects`. `world` and `worldRules` stay refused |
| May `create_room` produce a room nobody can reach? | No -- a door to an existing room is mandatory |

## Decision

**1. The shape rules move to one owner: `src/services/WorldStructureRules.js`.** The room
rules `RoomsController` has always enforced at boot (name, the three free-text environment
fields, the `ceiling`/`condition`/`power` enums, `connections`, `x`/`y`, `width`/`height`, the
eight-key `atmosphere`, both door position formats) are now functions returning a **list** of
violations, plus `assertRoomDefinitions` which throws the first -- byte-identical to the old
`TypeError` texts, which `test/unit/RoomsController.test.js` pins. Three callers, one text:

- **boot** (`RoomsController`, throws -- `E-8`, fail fast before the first request),
- **plan and apply** (`CompositionClassifier`, quarantines the definition -- the operator's
  own words in the plan report),
- **proposal** (`WorldProposalValidator`, which already runs that classifier -- so the model
  is refused in the conversation with the sentence boot would say tomorrow, and can fix it in
  the same turn).

Cross-reference rules (a connection target must be a room of the candidate; a prop's
`blueprint` and `room` must resolve) fire **only where a candidate exists**. Boot reads the
definition, not a candidate of one, and has never rejected a dangling door; that behaviour is
unchanged.

**2. `rooms` and `worldObjects` are authorable; `world` and `worldRules` are not.**
`NON_AUTHORABLE_KINDS` shrank to those two. A room and a prop are definitions, and a
definition that describes a place is no more dangerous than one that describes a component
once the rules above are shared. `world` is the shape the world is wrapped in, not something
inside it; `worldRules` install listeners, which is behaviour -- and a data-only proposal that
could install behaviour is a different security story than the one this feature tells
(`mod-system.md`, decision 1).

**3. The map grows at the swap, and only additively.** `RoomsController` gained `addRoom`,
`connectRooms` and `reconcile(definitions)`. `ModService` gained one injected callback,
`afterSwap(swappedKinds)` -- a plain function, for the same stated reason as the existing
`roundGate`: the package manager must not learn about rooms (`B-1`). The composition root
wires it to `roomsController.reconcile(store.read('rooms'))` when the swap wrote the `rooms`
kind. Both moments reach it, because there is one swap in this pipeline: the operator's
`POST /mods/apply` when no round is open, and the round boundary otherwise.

Additive means exactly this, and `reconcile` is the only writer:

- a logical key the map does not have is installed (fresh uid, the same record shape boot
  builds, doors resolved in a second pass so a room may point at a room the same definition
  declares after it);
- a room the map **does** have is never moved, resized, renamed or re-linked;
- a door an installed room does not have is added; a door it has keeps its target -- an
  authored re-point is not obeyed;
- **nothing is ever removed**: disabling the package that authored a room does not delete the
  room from a running world. It disappears at the next boot, from the same definition.

That is the whole safety argument for changing a map under a running simulation: an installed
room's uid is what entities, broadcasts and prose already named, so an update that edited one
would be a corruption wearing a legitimate request. An authored change to an existing room is
not refused (it is legal data, and a boot rebuilds from it); it simply does not move the room
that is already standing there.

A room the definition cannot build is **skipped with its rule text** in the reconcile report,
never thrown: the swap already happened, and trading a running world for one bad room is the
wrong trade. The report (`{ added, doorsAdded, skipped }`) rides along in the apply report as
`map`, and a `mapError` names itself if the step throws -- an apply that swapped is reported
as having swapped (`E-1`, never `AP-3`).

**4. Two live operations, both memory-only.** `WorldOperatorService` gained:

- `create_room` -- `{ logicalId, definition, connectFrom: { roomId, door, targetDoor?, position? } }`.
  `definition` is one room exactly as the `rooms` registry shapes it, so the model copies a
  shape it has already read instead of inventing a third one. `connectFrom` is **required**:
  a room nobody can walk into is not a room the world has. The door opens in both directions
  (a one-way door strands whoever uses it), and an existing door name is refused rather than
  re-pointed.
- `spawn_world_object` -- `{ blueprint, roomId, name?, position? }`, placing a prop now
  instead of waiting for the next world create.

Rooms may be named by uid (what the world runs on) or by logical key (what the definition
uses); `list_rooms` now answers with **both**, plus the door names it has, so a proposal can
name a real target. Both are executed through the facade, re-validated at execute like every
other operation, and neither touches disk: a runtime room is a fact about the running world,
gone at restart. The prompt says so, so the model offers the package when the operator
actually wants the room to stay.

**5. The facade grew three methods, deliberately.** `createRoom`, `spawnWorldObject` and
`getRoomLogicalId`, pinned in `test/contract/worldStateController.contract.test.js`.
`_spawnStaticProps()` now calls `spawnWorldObject` per entry: one path from a prop definition
to a prop in a room, so boot and the live lever cannot drift into two kinds of prop
(`CHG-2`).

**6. A live room's door comes from `connectFrom`, never from `definition.connections`.** The two
paths are asymmetric on purpose, and both are now said out loud (`WorldStateController.createRoom`
JSDoc, the `create_room` operation description, and the system prompt) rather than left for the
model to discover: a `rooms` *package* declares its doors in `connections` and the map opens them
where the door list is installed -- the constructor at boot and `reconcile` at the swap, both the
same two-pass install. The live `create_room` opens the one door named in `connectFrom` and
installs nothing from `connections`, whose *shape* is still validated because the definition object
it carries is the one a package would carry. WHY not honor it: a door needs a target uid on both
sides, and the live path mints the new room's uid after validation, so honoring a declared list
would mean a second door-installer with its own resolution order -- a second source of truth for
one fact (`CHG-2`), for a case the required `connectFrom` already covers. What a room-less prop
means, by contrast, is one rule in one place: `worldObjects` `room` is optional and names
`start_room` when absent (`_spawnStaticProps`), which is why it is pinned rather than assumed.

There is no "a room cannot connect to itself" check in `_checkRoomCreation`: it could not fire (a
key already installed is refused by the rule above it, and a new key has no uid until `createRoom`
runs), and the case that is reachable -- joining one installed room to itself -- is refused by
`RoomsController.connectRooms`, which owns that rule and is pinned there.

## Consequences

- A `system-*` package that authors `rooms` changes the running map the moment it is applied,
  with no restart. A hand-authored package does the same -- the mechanism is the swap, not the
  chat.
- A package that *renames, moves or deletes* a room still does not take effect until a restart,
  and now there is a documented reason rather than an accident. The plan/apply report cannot
  promise what the map will not do, so the reconcile report is in it.
- Rooms added at runtime are invisible to the definition. `GET /rooms` shows them, a restart
  does not. `list_rooms` and the `map` report are how an operator sees which is which.
- Props authored into a package still appear at the next world create, like NPCs do -- they
  are population. This is the one asymmetry with rooms and it is deliberate: rooms are the map
  (which the owner chose to keep live), props are things standing on it (which the boot pass
  spawns). Someone who wants a prop now uses `spawn_world_object`.
- A malformed room can no longer reach a running world through the pipeline at all: it is
  quarantined at plan/apply, and refused at proposal with the same text.
- `PROMPT_VERSION` for `system-authoring` went to `2.1.0`, then `2.1.1`: the model is told the
  map is authorable, what "additive" costs, that live map changes do not survive a restart, and
  (in `2.1.1`) that a live `create_room` opens only the door in `connectFrom` -- a review found
  the model could otherwise declare `definition.connections` and watch the shape pass while no
  door appeared.

## Rejected alternatives

- **Author and wait for a restart.** The smallest diff, and a feature that looks broken from
  the operator's chair: Write, Apply, and no room.
- **Honor `definition.connections` in the live `create_room`.** It would make the two paths
  identical, at the cost of a second door-installer (own resolution order, own conflict rules,
  own uid timing) for doors the required `connectFrom` already opens. The contract was narrowed
  and documented instead (decision 6); if a real ask ever wants several doors from one live call,
  that is the moment to build the shared installer, not before.
- **Rebuild `RoomsController` on swap.** New uids for every room, and every entity `location`
  orphaned. `recreateWorld` rejects the same idea in writing ("WHY the map survives").
- **Rebuild the map at `POST /world/create`.** A new world on a running process would still be
  the old map unless the whole process restarted, and it contradicts a decision note that
  states the opposite on purpose.
- **Auto-persist a runtime room by writing a package.** It would make executing a plan write
  to `data/mods/` without the operator's Write click -- the one authority this feature is
  built around -- and couple live mutation to the filesystem.
- **Room rules duplicated in the validator.** Two rule texts disagreeing is the standard way
  this rots (`T-2`); the whole point of the shared module is that plan, proposal and boot say
  one thing.
- **A boolean on the existing `spawn_entity` for "this is a prop".** `CHG-4`: a caller reading
  `spawn_entity(x, true)` cannot tell what `true` means, and a prop is not an entity with a
  flag -- it is excluded from the planner roster.

## Next change (when the owner asks for it)

1. **Remove or edit a room live.** `reconcile` never removes; a `retire_room` operation needs
   the hard conversation about what happens to what is standing in it.
2. **Map preview.** The card lists added room keys; it does not draw them. `getWorldGraph()`
   already has the graph, and the client map view already draws rooms.
3. **Room-level props in one action.** `create_room` plus `spawn_world_object` are two actions
   for one wish; a plan makes it readable, a compound operation would make it one click.

## Rule touchpoints

`T-2` (one rule set, three callers, no re-guard downstream); `E-8` (boot still fails fast on
a room it cannot build); `E-1` (a reconcile skip is a reported outcome, not a swallowed error);
`AP-3` (an apply that swapped is never reported as a failure); `B-1` (`ModService` receives a
plain callback and never learns about `RoomsController`); `CHG-2`/`CHG-8` (the prop spawn
exists once; the map is not rebuilt by this change); `CHG-4` (a definition object, not a
fourteen-field options bag); `SEC-4` (model output is a room definition the world's own rules
check, never a path or a command); `D-2` (room ids stay `generateUID()`, minted in
`RoomsController`); `PERF-3` (`getLogicalId` is a scan, not an index, and is not a turn path);
`TST-4` (rules and reconcile in unit, the swap-to-live-map claim in integration);
`DOC-3`/`DOC-4` (this note, the two notes it amends, and the `AGENTS.md` kind list).
