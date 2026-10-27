# Round Prose System (Feature G — "round N in natural prose")

## Why

Perception keeps a per-room ring of "what changed since I last saw it" delta
entries — each stamped with its own tick and carrying a one-line human summary
(`buildDeltaSummary`, [perception_system.md](./perception_system.md)). The turn
system keeps, per round, the tick window in which the round ran
(`startTick..endTick`; `endTick` null while the round is live, closed by the
barrier — [turnSystemController.js](./turnSystemController.js)). Nothing existed
to *read a round back* as a coherent scene. The round-prose system crosses those
two reader sources:

```
round N prose = every perception entry whose tick falls in round N's
                [startTick, endTick], assembled per room into one flowing
                paragraph, plus a one-line round summary.
```

It is a **reader, not a state owner**: no mutation, no tick ownership, no
`getAll()` (out of the broadcast aggregate by the same rule as the perception
controller — see WorldComposition.js).

## Components

| File | Role |
| --- | --- |
| `src/controllers/core/RoundProseController.js` | reader: window (turn) × ring (perception) → prose |
| `src/utils/RoundProseBuilder.js` | pure assembly: `buildRoomProse`, `buildRoundProse` |
| `src/controllers/core/TurnSystemController.js` | added: per-round tick-window bookkeeping (`_roundWindows`, `getRoundWindow`); constant `ROUND_PROSE_HISTORY_LIMIT` |
| `src/routes/perceptionRoutes.js` | added: `GET /perception/round/:n`, `GET /perception/round/:n/byRoom/:roomId` |

## Contract

- **Read path**: routes → `worldStateController.roundProseController` →
  `facade.turnSystemController.getRoundWindow(round)` + `facade.getRooms()` +
  `facade.getPerceptionDeltasForRoom(roomId, { limit: PERCEPTION_MAX_LIMIT })`.
  Nothing else touches the perception controller directly (single read-seam).
- **Prose**: one paragraph per room = that room's entry summaries, oldest
  first, joined; one trailing period. Round summary:
  - closed, has entries: `Round N (ticks a to b) recorded X observable change(s) across Y room(s).`
  - closed, empty: `Round N (ticks a to b) passed with no observable changes.`
  - live, has entries: `Round N (ticks a to b) is still planning; X observable change(s) across Y room(s) so far.`
  - live, empty: `Round N (ticks a to b) is still planning (no change yet).`
- **Errors**: 400 (malformed round), 404 (unknown room / round out of recent
  history), 503 (reader unwired). 200 `{ success: true, ... }`.

## Degradation (honest, by design)

A round is reconstructable only while it is inside **both** horizons:

| Horizon | Bounded by | Lost when |
| --- | --- | --- |
| perception rings | `PERCEPTION_MAX_LIMIT` (50) entries per room, oldest evicted first | oldest entries evicted |
| turn round windows | `ROUND_PROSE_HISTORY_LIMIT` (500) rounds, in memory | reset / restore / eviction |

Past either horizon the reader returns `null` and the route responds 404 —
"not observed", not an error. Nothing crashes; the prose simply stops being
available. (Rounds are not persisted: this is a recent view, not an archive.
If an archive becomes a requirement, that is a new decision — persistence would
belong to a state owner, not a reader.)

## Determinism

Prose is byte-deterministic: built from names, counts, and coordinates only
— no ids, no timestamps, no LLM output — two identically driven worlds produce
byte-identical round prose (pinned in the contract tests).

## Tests

- `test/contract/roundProse.contract.test.js` — real world: live round
  reporting, closed-round tick scoping, idempotent re-read, determinism across
  two builds, eviction, express/fetch wire shape (200/400/404/503), and the
  existing room endpoint left intact.
- `test/unit/RoundProseBuilder.test.js` — the pure prose contract, byte-exact.

## Open direction (not decided)

The LLM already reads this same delta stream per-agent. An open question
(not decided by this change) is whether a *generative* scene prompt (an LLM
call over the same windowed entries) would be a better consumer for a UI that
wants "cine" text — the data surface this system provides (windowed entries +
per-room paragraphs) is exactly what such a prompt would consume.
