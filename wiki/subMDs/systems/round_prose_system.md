# Round Prose System

*Living document — this file is the source of truth for the round-prose feature. Keep it in step with the code (CODE_RULES.md section Documentation).*

## What it does
- Reads a **round** of simulation (an interval of ticks in which the turn system
  played one or more NPC turns) and produces **prose**: a flowing paragraph per
  room summarizing what happened in that round, plus a one-line round summary.
- Reads the same round **from one entity's side** (`byEntity`): the paragraph of
  what that round did *to and by one entity* — what it did (against what, with
  which parts), what was done to it, its stat / component shifts, what it picked
  up, dropped, equipped or wore, its arrival and departure, and the lines it
  said.
- The prose is deterministic given the world state: no LLM involved; the "writing"
  is templated from perception deltas.
- History is recent-only, by design: the in-memory reader horizon
  (`ROUND_PROSE_HISTORY_LIMIT`) is bounded; older rounds are not re-renderable
  (and there is no need to be — a full replay is a separate concern).

## Narrative format (`buildRoomProse`, data-rich)
- **Room context** — the first sentence opens with the room's full context,
  whatever the room record supplies: `In The Entrance Hall (20 x 12, map
  position (4.00, 7.00), and a stone hall with a north door), ...`. The context
  is drawn from the room's `name`, `description`, `width`/`height`, and map
  `x`/`y`; missing fields are simply omitted. The room is then named at most
  once per paragraph.
- **Clauses are rendered per delta entry, in reading order**: main actions
  (who, what, **against what**, **powered by which components**), floor objects
  (who, what, **where — coordinates in the perception display rule**,
  `shared/CoordFormat.js`), held/equipped items (who, what, which hand),
  machines (**placed / retrieved**: who, what, where), presence
  (appeared / left / **moved from where to where, at which coordinates,
  powered by which locomotion parts**), stat changes (**which stat, from which
  value to which**), component/equipped/internal parts (who, which part, which
  stat, from/to values), and room chat (who said, verbatim).
- **Determinism and safety**: raw ids never appear (they resolve to a generic
  noun via `isIdLike`); coordinates always use the perception `00.00` rule;
  stat values are normalized (at most 8 decimals, float noise stripped, no
  padding). Same world state -> byte-identical prose (unit tests pin the exact
  string).
- **`kind: 'baseline'`** rounds render as a state fact, not an event: `Initial
  observation of <room>: <who/what is in the room>`. Machine presence is
  phrased as `... stands in the room (placed by <who>) at (x, y)`, and machine
  entity rows are not narrated a second time (the `machines` entry owns them).

## Components
- **TurnSystemController** (owner of round bookkeeping)
  - `getRoundState()` / `getRoundStateNumbers()` — live round (number, tick,
    live flag).
  - `getRoundWindow(round)` — the tick window of one round `{round, startTick,
    endTick, live}`, `null` when evicted or pre-start.
- **RoundProseController** (reader assembly)
  - `getRoundProse(round)` — one round, as prose:
    `{ round, live, startTick, endTick, summary, entryCount, rooms }`, where
    `rooms` is a map `roomId -> { name, text, entryCount }` (`roomId` is the
    perception uid, the same one the UI displays). `null` when the reader is
    unwired.
  - `getEntityProse(entityId, round)` — one entity's round, as prose:
    `{ round, live, startTick, endTick, entityId, entity, room, entryCount, text }`
    (`entity` is its display name, `room` its current room name or `null` when it
    is gone). Built by `buildEntityProse` / `selectEntityRows`
    (`src/utils/RoundProseBuilder.js`), which reuse the room narrative's clause
    builders — the same event reads with the same words in both views, and the
    entity function contributes no phrasing of its own. `null` only when the
    reader is unwired or the round is out of the window.
  - Summary shape (verbatim):
    - live round, no entries: `Round N (ticks S to E) is still planning (no change yet).`
    - live round, entries: `Round N (ticks S to E) is still planning; X so far.`
    - closed round, no entries: `Round N (ticks S to E) passed with no observable changes.`
    - closed round, entries: `Round N (ticks S to E) recorded X observable change(s) across Y room(s).`
- **PerceptionController** (data seam for the prose)
  - `getRoomProse(roomId, round)` — the single-room projection (the `text` of one
    room's prose), plus `getRoundSummary()` — the one-line summary, both
    derived from the per-room ring + the turn system's window.
- **Routes** (`perceptionRoutes.js`)
  - `GET /perception/round/:roundNumber`
  - `GET /perception/round/:roundNumber/byRoom/:roomId`
  - `GET /perception/round/:roundNumber/byEntity/:entityId` — one entity's
    paragraph for one round. 400 for a malformed round or a non-`ent-…` id, 404
    for a round out of the recent-history window, 503 when the reader is unwired.
    An entity that **no row named** is a `200` with `entryCount: 0` and empty
    text, not a 404: the round window alone decides the 404, so a droid that
    despawned mid-round is still readable.
  - `GET /perception/rounds/:from/:to` — inclusive range of rounds, one row per
    requested round, ascending. Observed rounds carry the single-round shape;
    evicted rounds return `{ round, observed: false }` (partial result, never a
    404 — a range may span an evicted gap). 400 for malformed bounds,
    `from > to`, or `to` beyond the current round (named in the message); 503
    when the reader is unwired.

## Contract
- **No LLM in the path**: the prose is pure JS assembly of perception data
  (`CODE_RULES.md` section Determinism / NPC-LLM domain).
- **Deterministic**: same world state -> same prose (tested).
- **Read-only**: the controller never mutates world state; it reads
  perception + turn-system windows.
- **History is recent-only**: out-of-horizon rounds are `null` / absent, not
  an error.
- **Room identity**: the `roomId` in prose is the perception uid (the
  controller's key), not a logical name; the UI maps it to a display name.
- **Error shape**: `503 { error: "Round prose reader is not available." }` when
  the reader is unwired (a world without a reader must not 500).
- **Entity prose is only what NAMES the entity.** Identity lives in different
  fields per delta bucket (`DeltaDiff` owns that shape): an entity / machine row
  by its own `id`, a component / item / equipped / internal row by its owning
  `entity`, a floor row by `ownerId`, a chat line by `speakerEntityId`, a
  machine row by `placedBy`, an action row by its actor `entity` **and** by its
  `target.id` — a row where the entity is the victim is its prose too. Rows that
  name somebody else never appear.
- **A baseline is never one entity's prose.** A baseline describes the room as
  first observed, not something that happened to one entity; so an entity's
  arrival into a room nobody had observed yet is that room's baseline and stays
  out of its paragraph (the departure from the room it left is a delta, and is
  there).
- **The entity read walks every room.** Rings are per room, and an entity can
  cross a door mid-round, so the read collects from every room's ring in the
  window. Ordering is tick first, then the world's own room order (`Array.sort`
  is stable) — room ids are generated per world build, so they must never be a
  tiebreaker: two rooms' rows for one round carry the same tick, and sorting by
  uid would reorder them differently on every boot.
- **Room uids are not names.** Room rows reference rooms by uid; `isIdLike`
  rejects a bare uuid, so a move clause says `moved from (0.00, 0.00) to (12.00,
  9.00)` rather than echoing a generated uid (which would also read differently
  on every build).

## UI
- A single overlay panel (`public/js/RoundProsePanel.js`), opened from the
  config bar (`#btn-round-prose`). It renders:
  - the round header (number, start tick, end tick, live flag)
  - the one-line summary
  - per-room prose blocks (name, text, entry count)
- **Range view** (`/perception/rounds/:from/:to`): two numeric inputs
  (from/to), a Live button (fetches the live round as a range of length one),
  and a refresh button. Renders a range header line (`range N→M`, `X of Y
  observed`, optional missing count) and one section per requested round;
  evicted rounds render a one-line marker (`Round #k — not observed`).
- **Entity mode**: an `entity` text field next to the range inputs. Typing an id
  (`ent-…`) switches the read to `byEntity` — one paragraph for ONE round (the
  `from` input), with `to` disabled while a name is typed, because silently
  ignoring it would be the confusing version. Emptying the field returns to the
  range view of all rooms.
- The client is disposable by design: every rule of the world lives server-side;
  the panel is a pure renderer of the wire shape.

## Tests
- `test/contract/roundProse.contract.test.js` — the contract suite:
  1. live round shape (live:true, endTick = current tick, summary "still planning")
  2. closed round shape (summary "recorded N observable change(s) across M rooms")
  3. no-entry round shape ("passed with no observable changes")
  4. single-room prose shape
  5. wire shape (express/fetch, 200/404/503)
  6. room-name resolution (logical name -> uid)
  7. reader unwired (503, never a crash)
  8. eviction: rounds beyond the horizon resolve to `null` / `observed:false`
  9. range reader: one row per requested round, observed:false for evicted gaps
  10. range reader live window (endTick at read time)
  11. range wire shape (200 range + evicted gap, 400 on bounds/current, 503)
  - E1-E6 (one entity): round 0 is a baseline so the entity has none; what it did
    in a round, with no room atmosphere and no room framing; the read is not
    pinned to the room the entity stands in now; movement inside a room; an
    entity no row named and an entity that is gone; determinism across two
    identically driven worlds; wire shape (200 / 400 round / 400 non-entity id /
    404 unknown round / 200-empty unnamed entity / 503).
- `test/unit/RoundProseController.entity.test.js` — the reader with a stub facade:
  reads every room ring in tick order, keeps only rows naming the entity (never
  another's, never a baseline), reports a gone entity by the name its rows carry,
  and orders ties by the world's room order rather than by room id.
- `test/unit/RoundProseBuilder.test.js` (`buildEntityProse` / `selectEntityRows`)
  — the selection and labelling, byte-pinned: the victim view, the display name
  replacing the generic fallback, baselines excluded, `entryCount` counting only
  the entries that said something, no raw ids in the text.

## Open questions
- (none yet — the feature is stable; future work is UI polish and
  persistence, both out of scope by design)
