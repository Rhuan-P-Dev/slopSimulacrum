# slopSimulacrum

A persistent, data-driven world simulation in which LLM agents live as NPCs.
Droids (and the LLMs driving them) roam rooms, carry inventory, craft items,
take damage, lose components, burn coal to stay alive, and act in turns —
all governed by JSON data files, not code.

The server is the product: a Node.js/ESM core with an Express 5 + Socket.IO
API and a thin single-page browser client. The client is disposable by
design — every rule of the world lives server-side.

## Quick start

Requires Node 20.19+ (22+ recommended).

```sh
npm install
cp .env.example .env   # optional — every variable has a safe default
npm run dev            # http://localhost:3001
```

The server boots with zero configuration: the world builds itself from
`data/*.json`, NPCs spawn from `data/npcs.json`, and the client connects
over Socket.IO.

Run the test suite (vitest, unit + contract; the run prints the file and test counts):

```sh
npm test
```

## Configuration

All variables are optional (see `.env.example` for the full annotated list).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3001` | HTTP/Socket.IO port |
| `MAX_BODY_LIMIT` | `512kb` | JSON body size limit for every request (stops an unbounded body becoming a memory event) |
| `CORS_ORIGINS` | *(unrestricted)* | Comma-separated Socket.IO CORS allowlist; the client is same-origin, so default empty works locally — set it before exposing the server |
| `LLM_ENDPOINT` | `http://127.0.0.1:20003/v1/chat/completions` | Any OpenAI-compatible chat-completions URL (local models work) |
| `LLM_API_KEY` | *(none)* | Bearer token; unset = no auth header |
| `LLM_MODEL` | `gpt-3.5-turbo` | Default model id |
| `LLM_TIMEOUT_MS` | `30000` | Per-LLM-call timeout |
| `KILLER_LLM_DRONE_ENABLED` | *(off)* | Spawns the `killerLlmDrone` NPC when `"true"`; read once at boot |
| `REQUIRE_AUTH` / `API_TOKEN` | *(off)* | Bearer-token gate for every API request (production) |

### Request budget (rate limiting)

The two endpoints that reach the LLM — `POST /api/chat` and
`POST /api/rooms/:roomId/chat` — are guarded by a dependency-free
sliding-window limiter (`src/utils/rateLimiter.js`):

- **Budget:** 20 requests per 60-second window per client key (code-level
defaults of `createRateLimiter`, not environment variables).
- **When over budget:** the request is rejected before the upstream call,
  with `429 Too Many Requests`, a `Retry-After: <whole seconds>` header
  (computed from the oldest hit in the window), and body
  `{ "success": false, "error": { "code": "RATE_LIMITED", "message": "…" } }`.
- **Trust-proxy caveat:** the limiter keys on `req.ip`, and Express only
  reports the real client address when `trust proxy` is configured — it is
  not, today. Behind a reverse proxy every client therefore shares the
  proxy's one bucket. Do not enable `trust proxy` unless the app really is
  behind a proxy that rewrites `X-Forwarded-For`: otherwise a caller can
  pick its own bucket by spoofing that header.

## Architecture

```
public/                 thin client — one page (map, actions, inventory,
                        crafting, turns, chat); replaceable without touching the core
src/
  server.js             boot (Express 5 + Socket.IO + dotenv)
  routes/               16 API route groups (world, crafting, inventory, turns, llm, ...)
  composition/          WorldComposition.buildWorldState() — the composition root:
                        constructs all sub-controllers in dependency order
  controllers/
    WorldStateController.js   the facade — the only thing routes talk to
    logic/                    extracted business logic (FASE 6–7): NpcSpawnLogic,
                              InitialSpawnLogic, CraftingLogic, RemovalCascadeLogic,
                              PersistenceLogic, CardSpawnLogic, EquipLogic,
                              ContainerItemLogic
    core/  networking/  consequences/  ...   sub-controllers (rooms, entities,
                        components, inventory, crafting, damage, turns, LLM, ...)
  services/             broadcast service (state → clients)
  utils/                DataLoader, Logger, tick system, samplers, ...
shared/                 constants shared by server and client
data/                   the world, as data (see below)
test/                   vitest: unit + contract suites
wiki/                   agent-facing docs (architecture maps, project rules, specs)
```

Conventions the codebase enforces (see `wiki/CORE.md`): one-way data flow,
public-API-only communication between controllers, all JSON loaded through
`DataLoader.loadJsonSafe`, and a single facade between routes and state.

## The world is data

Everything an author touches is JSON in `data/` — no code changes to ship
content:

| File | What it defines |
| --- | --- |
| `world.json` | declarative initial spawns for spawned entities |
| `rooms.json` | the map: rooms, geometry, connections |
| `npcs.json` | the NPC registry (LLM-driven droids, optional env gates, per-round action caps, initial items) |
| `blueprints.json` / `components.json` | entity blueprints and their component definitions |
| `inventoryItems.json` / `materials.json` | items, volumes, material damage/drop rules |
| `crafting.json` | recipes (input multiset → output, volume pre-checked before any mutation) |
| `internalComponents.json` | organs (e.g. the coal generator that burns coal into energy) |
| `traits.json` / `entity_attributes.json` / ... | stats, traits, holding costs, synergy, world rules |

World state survives restarts: `POST /api/world/save` / `POST /api/world/load`
round-trip the full state through a versioned schema.

## Development

```sh
npm test               # vitest run
npm run test:watch
npm run test:coverage
npm run lint           # eslint (strict: unused imports are errors)
npm run check:lang     # fails if Portuguese (accents / PT words) leaks into the codebase
```

Long-running refactor work is tracked in the commit history as FASE stages
(FASE 5 = dependency-injected composition root; FASE 6–7 = facade logic
extraction into `src/controllers/logic/` — FASE 7 moved the persistence
codec, card-droid spawning, equip API and nested-inventory clusters).
Architecture maps live in
`wiki/map.md` and must be updated when the controller graph changes.

## License

ISC — see `package.json`.
