# Decision: the judged `{{user}}` relationship of a bound card reaches the bound-to card's context

Date: 2026-07-22 (recorded in the change that implements this)

## Context

Two features already exist and are orthogonal:

- **Card `{{user}}` mapping** (`card-user-mapping.md`): at world create, a card
  whose persona carries a `{{user}}` token can be bound to another card, and the
  token in its prompt is replaced with the target card's display name. The
  binding is a per-spawn fact carried in the bound card's `npcConfig`
  (`userCardId`, `userName`).
- **Card `{{user}}` relationship** (`card-user-relationship.md`): the LLM
  judges, per card, which relationship that card's character has with its
  `{{user}}` — a free-form label plus one short sentence — and stores it in a
  sidecar next to the card's PNG. The note records that the judgment is a
  dev/display aid: the verdict was not injected into any NPC prompt and the
  world did not consume it.

The owner asked to close that gap: **when card A's `{{user}}` is replaced by
card B's name, card A's judged relationship with the `{{user}}` should be added
to the context of card B** — the droid the token now names is the one that
should know that a particular droid treats it as its user, and how. The owner
also asked to be **warned in the frontend when card A's relationship gets
judged**.

## The decision

- **Where the attachment happens (SPAWN, not round, not the judgment).**
  `CardSpawnLogic.spawnCards` calls `attachBoundUserRelationships` after its
  spawn loop, and only when a user mapping was given. For every binding whose
  source **and** target both spawned, the source's sidecar is read through the
  data seam (`CardRelationshipStore.readFreshCardUserRelationship`) and the
  verdict is written into the **target's** per-entity `npcConfig` as
  `userRelationships` — an array of `{ cardId, name, label, summary }`, because
  several sources may bind to one target. The target's agent round renders it
  in the **system prompt** (`LLMAgentController._buildSystemPrompt`, a new
  section between the persona line and the world rules):

  ```
  Other droids whose user is you (their cards were bound to name you as the user they serve):
      - Nova regards you as "devoted partner": Nova adores you and protects you.
  ```

  The `{{user}}` a model-written label or summary still carries resolves to the
  target's own display name (the same substitution the bound persona gets, so
  the sentence reads in the name the source addresses — never a card id, never
  a literal token). This is the only injection point: the judgment stays a
  judgment, the world definition stays untouched (CR B-2), and the verdict is
  not written anywhere on disk — the sidecar next to the source's PNG remains
  the single source of truth, and the attachment is rebuilt at every world
  create.
- **Freshness is the judgment's own rule, shared from one place.** A verdict
  attaches only when its sidecar is fresh: current `SIDECAR_VERSION`, a
  `personaHash` still matching the source card on disk, and a well-formed
  relationship (non-empty label and summary). To keep the judge and the spawn
  from drifting apart, the freshness contract (`personaHashFor`,
  `effectivePersonaFor`, `effectiveCardName`, `sidecarPathForId` and the
  fresh-read itself) was moved from `CardUserRelationshipController` into the
  data seam `CardRelationshipStore`, and both consumers compose it
  (CHG-2). Every degradation is silent-and-skip, matching the spawn's own: a
  never-judged, stale, malformed, or unreadable source attaches nothing, and a
  world without judgments (or without a mapping) is byte-identical to before.
- **The frontend notice is local to the tab that asked (owner decision).**
  There is **no broadcast**: no socket event, no world-wide notification. When
  the Cards tab's "Judge {{user}} relationship" (or "Re-judge") click
  succeeds, that tab alone is notified — the row updates in place, the status
  line carries the verdict in the green tone (`judgedNoticeMessage`:
  "Nova's {{user}} relationship was judged: "devoted partner"."), and the row
  flashes once (`cards-row--judged`, a CSS animation removed by its own
  one-shot `animationend` — no timer to tear down, A-3). The other tabs and any
  other open client simply re-read on open, the way they already do; the
  judgment is persisted server-side, so no information is lost by not
  broadcasting. A broadcast would be a protocol change (new socket event, new
  listener in `App.js`) for a notification the owner scoped to the clicker.

## The consequences

- A bound source that was judged before the binding (or vice versa) works:
  the join happens at world create, so the two features never need to happen
  in a particular order.
- The target's prompt grows by at most a short block; a target bound to many
  sources grows one line per source. The bound source's own prompt is
  unchanged — the source carries the binding, the target carries the
  relationship.
- Re-judging a card and then recreating the world changes what the target
  sees; the target's entity is not mutated in place (the attachment is
  per-spawn, like the binding).
- The spawn re-reads each bound source's PNG once, at world create only (to
  recompute its persona hash for the freshness check) — never per round,
  never in the hot path (CR PERF-4). The test pins the fresh-judgment read
  (one `readFreshCardUserRelationship` call per source); the raw PNG read is
  the seam's single read per file.

## How it is enforced

- `test/unit/CardSpawnLogic.test.js` (the `attachBoundUserRelationships`
  block): the verdict lands in the target's `npcConfig` with the source's
  world name, never in the source's; stale/missing verdicts attach nothing
  (the target gains no `userRelationships` key); both-present-only; a light
  facade without an entity store degrades without throwing; no mapping means
  the path is never entered.
- `test/unit/CardUserPrompt.test.js` (the judged-relationships block): the
  section renders in the target's system prompt with `{{user}}` resolved to
  the target's own name, sits between the persona line and the world rules,
  filters malformed entries, and is absent when there is nothing to attach.
- `test/unit/CardRelationshipStore.test.js` (the freshness block): the shared
  helpers — the hash is deterministic and both inputs feed it, the effective
  persona mirrors the spawn precedence and stops at the empty string (the
  default is spawn-owned, CHG-7), the effective name falls back to the card
  id, and the fresh-read rejects version drift, hash drift (persona or name),
  and malformed relationships while degrading a missing `judgedAt`.
- `test/unit/CardsPanel.client.test.js`: `judgedNoticeMessage` says whose
  relationship was judged and the verdict, and degrades on empty parts.

## Related

- `wiki/decisions/card-user-mapping.md` — the binding this feature joins to.
- `wiki/decisions/card-user-relationship.md` — the judgment and the sidecar
  this feature reads (its "Consequences" note covers where the attachment
  reaches and where it stops).
- `wiki/decisions/llm-npc-prompt.md` — the prompt assembly this section joins.
