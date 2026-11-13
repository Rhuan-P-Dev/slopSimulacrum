# Decision: The System — an operator wish becomes a data-only mod package

## Context

The owner asked for "the System": a surface that listens to what somebody wants the world
to contain and creates the modifications. The frontend ask was explicit — a new tab called
**System** with a chat in it. The hard part was never the chat; it is what a model's words
are allowed to become in a persistent, data-driven world that is running while somebody is
talking about it.

Constraints that shaped this, all from `CODE_RULES.md` and the decisions already on file:

- `wiki/decisions/mod-system.md`, decision 1: **a mod is data only.** No code is read,
  imported or executed. So "create the modifications" cannot mean "write a module".
- Decision 4: a definition swap happens at the **round boundary**, never mid-round. Nothing
  in this feature may become a third apply path.
- Decision 5: a package shadows by key. Redefining official content is the mechanism, so a
  proposal that does it is legal — and must be visible, not discovered later.
- `RP-1`, `RP-2`: a new prompt kind is a named decision, versioned. `B-2`: only
  `LLMController` speaks to the provider. `B-3`: only the data seam touches the disk.
- `SEC-4`: model output is untrusted data — never a command, never a path, never markup.
- `SEC-9`, `A-7`: a provider call costs, and an in-memory map must have a number next to it.
- `T-1`/`T-2`: narrow once, at the edge; never re-guard downstream.

The owner chose (before code): a data-only package as the write target, proposal-plus-click
as the authority, a config-bar dev tab as the surface, and a tool-calling agent as the
mechanic. Those four answers are the shape below.

## Decision

**One LLM prompt kind, three modules, two clicks, zero applies.**

```
operator wish
  -> WorldAuthoringController (prompt kind `system-authoring`, tool loop, sessions)
      reads the live definition through tools  -> list_registries | read_registry | find_definitions
      puts a package on the table              -> propose_mod   (validated, frozen, in the session)
  -> operator reads the answer and the proposal card
  -> POST /system/write  { sessionId }         -> WorldProposalValidator again -> ModPackageWriter
  -> data/mods/system-<slug>/{mod.json,<kind>.json}
  -> POST /mods/apply (the existing verb)      -> swaps at the round boundary, or defers
```

**1. The System authors content — and, since
[`world-structure-authoring.md`](./world-structure-authoring.md), the map too.**
`AUTHORABLE_KINDS` was every registry kind except the world family: `rooms`, `world`,
`worldRules` and `worldObjects` refused with a named reason, because reshaping the world the
simulation runs in is a hand decision with different rules, and a model should say so rather
than approximate it. That held until the owner asked the System to create rooms and props.
What made the map safe to author was not a wider permission but machinery this feature
already had: the room rules `RoomsController` enforces at boot became one shared module
(`WorldStructureRules`), so a room is refused in the conversation with the sentence the boot
path would say tomorrow, and an applied room joins the running map **additively** — an
installed room is never moved, renamed, resized or removed by a swap. `world` and
`worldRules` are still refused, with their reasons in the note. Read that note before editing
this list.

**2. The server owns the package identity.** The model proposes a slug; the server writes
`system-<slug>` and refuses the reserved `core-` prefix outright (`MOD_ID_PATTERN`, checked
before any path is built, `SEC-7`). The same reasoning that took the blueprint id away from
the model in `agent-body-design` v1.1.0: authoring structure is the model's job, naming
identities into the filesystem is not.

**3. Reading before writing is a tool, not a prompt dump.** The four tools are the model's
only way to learn what exists; the vocabulary is not pasted into the prompt. A model that
must call `read_registry` before it cites `steel` is a model that cannot invent a material.
Three reads and one terminal `propose_mod` — a tool set that needs twenty entries is a
design that has not found its four (`B-6`).

**4. A refusal is data, not a crash.** `propose_mod` answers with the validator's rule list,
so a bad reference comes back as `"components plate: Unknown material \"unobtainium\".
Available: steel"` and the model fixes it inside the same turn. The rules it hits are the
world's own: the candidate (live definition + proposal) goes through the same
`CompositionClassifier` that `POST /mods/plan` uses, so "what the System may propose" and
"what the world will install" are answered by one set of rules, not two.

**5. Two validations, one trust.** The proposal is validated when the model proposes, and
**again** when the operator clicks Write — the world may have moved in between, and an
override that was not there when the model asked must be reported before the write, not
after. The write route takes a `sessionId` and nothing else: the client cannot post a
package body, so the door that writes to `data/mods/` writes only what this server
validated.

**6. Nothing is applied here.** `POST /system/write` writes files and rescans the package
directory. It answers `applied: false, appliesVia: 'POST /mods/apply'`. `ModService` stays
the one apply mechanism (`requestApply` now, or the round boundary), and the System tab's
status line points at Mods. Two things a chat could do to a running world and did not.

**7. The conversation is bounded and the policy is written down** (`RP-3`, `A-7`): last
`MAX_HISTORY_MESSAGES` (24) messages per session, `MAX_SESSIONS` (16) sessions in memory
(oldest-used eviction), `MAX_TOOL_ITERATIONS` (12) provider calls per turn, tool results
capped in characters with a `truncated` marker.

**7b. Two numbers came from running it, not from guessing.** The first live turn against the
configured model spent six calls reading registries one at a time and ended with no proposal
and no answer — a cap that stops a model before it can answer is not a saving, it is a broken
feature. So: the cap went to 12; a `read_registry` listing now carries one real definition as
`sample` (the shape, without a second call per kind); every tool answer carries
`callsRemaining`, because a budget the model cannot see is a budget it wastes; and the prompt
says *propose early*. The same wish then read seven calls, proposed `materials.chromeScrap`
plus `inventoryItems.mirrorShard`, and explained the trade-offs — and the operator's Write
button produced a three-file package `GET /mods` listed. When a number in this file is
measured, this section says so. **Tool traffic is never replayed** — an
accepted proposal is remembered as one line, `[proposal on the table: system-x, 1 kind, ...]`,
which is what a refinement turn needs. Sessions are in memory only; a restart clears the
conversation and leaves the packages alone.

**8. The history is wishes and replies only.** The replayed array is `user`/`assistant`
text, so trimming can never orphan a `tool_calls` message (the protocol `LLMController`
validates), and the token cost per turn does not grow with how much the model read.

## Consequences

- A **fourth prompt kind** exists: `system-authoring` (v1.0.0), owned by
  `WorldAuthoringController`. A prompt change is a `PROMPT_VERSION` bump in that file.
- `ModPackageWriter` is a new writer and needed a **directory**, which the seam did not
  offer: `DataLoader.ensureDir()` and `DataLoader.exists()` joined the seam in this change
  (`B-3b`). No new file joined `DATA_SEAM_FS_FILES`; the writer imports no `fs`.
  `exists()` is there because asking "is it there?" by reading it logs an ERROR on every
  first write of a file that is about to be created.
- `data/mods/` gains a new kind of resident: `system-*` packages. They are third-party by
  construction (no `core-` prefix), so `GET /mods`, the launcher, enable/disable, move and
  apply all work on them unchanged, and the official-set contract test is untouched.
- A written package is **not** enabled-queued: the state file says nothing about it, so it
  loads at the default `loadOrder` once applied — and shadowing follows the load-order rule
  already recorded (`system-` sorts after `core-`, so a System package overrides the
  official one at equal order; that is the documented mechanism, not a new one).
- The client sends no world knowledge: `SystemPanel` renders what the server returned, with
  `textContent` everywhere — model output never becomes markup.
- **The Write button's enabled state is a rule, not a paint artifact.** The transcript is
  repainted while `_inFlight` is still true, so a `disabled` computed once at paint time
  freezes the button disabled — and a click on a disabled button fires no event, which is a
  control that does nothing with no error in any log (this is exactly what the operator hit
  on the first live teleport proposal). `refreshWriteButton` is the single place that reads
  `_written || _inFlight`, and `setBusy` calls it. Pinned by `SystemPanel.client.test.js`,
  which fails if the bake comes back.
- `npm test` pins, among others: nothing is written during a conversation; the world
  structure kinds are refused; the composition rules come back to the model as text; the
  history never replays tool messages; `/system/write` posts a session id and nothing else.
- The one thing a chat can still do to a running world is cost, and the route caps it:
  `chatLimiter` in `src/routes/systemRoutes.js` allows 10 turns a minute on `/system/chat`
  (each turn is up to `MAX_TOOL_ITERATIONS` provider calls) and answers a `429` that says
  when to come back; `writeLimiter` allows 20 writes a minute, which cost no provider call.
  The conversation itself is free — the history is text and the tools read in-memory
  registries (`SEC-9`).

## Rejected alternatives

- **Write into the official `core-*` packages.** The `agent-body/save` precedent exists,
  but a chat turn is not an operator editing a file: one bad proposal would degrade shipped
  content. The owner chose a package of its own, disableable in one click.
- **Auto-apply on every proposal.** It reads as the feature ("say it, see it") and it is
  forbidden by decision 4: an in-flight action would see its definition change underneath
  it. Kept as a rejection rather than a waiver, because the temptation is permanent.
- **Let the model write code.** "Create the modifications" could be read that way. A mod is
  data (`wiki/decisions/mod-system.md` §1), and `SEC-4` refuses the execution path. If this
  is ever wanted it is a different feature, with a sandbox, not a looser version of this one.
- **Dump the registry vocabulary into the prompt** (the `agent-body-design` shape). Rejected
  because the body designer's vocabulary is a few hundred lines and bounded; the world
  definition is 21 registries that grow. Reading through tools also makes the read auditable
  in the tool log instead of invisible in a prompt.
- **Streaming the answer over Socket.IO.** Chosen against for v1: a new event vocabulary in
  `shared/SocketProtocol.js` plus a stream contract (`RP-6`) and listener teardown (`A-3`)
  for a typewriter effect on a dev tab. The turn is a handful of seconds; the cost was real.

## Next change (when the owner asks for it)

1. **Undo.** A written package is deleted or disabled by hand today. A "retract this
   package" verb (delete the directory the System wrote, rescan, and answer where it applies)
   is the obvious next step, and it needs its own rule: only a `system-*` package may be
   retracted by the System.
2. **Iterate in place.** Refining a wish rewrites the same `system-<slug>` package with
   backups; what is missing is the operator saying *which* package a wish belongs to, rather
   than the model naming it again.
3. **A proposal diff.** The card shows added keys and overrides; it does not show the
   before/after of an override. `GET /mods/plan` already computes that — showing it next to
   the Write button is wiring, not design.
4. **Persistence of the conversation**, if it ever matters across restarts. Deliberately not
   built: an ever-growing JSON file of chat text is what `P-8` calls a log in a data file.
5. ~~**The map**, if the owner ever wants the System to touch `rooms`/`worldObjects`.~~
   Built, and the predicted blocker did not arrive: the plan step was already there — the
   classifier at the candidate, and the live plan. What the preview turned out to be is the
   rule list. See [`world-structure-authoring.md`](./world-structure-authoring.md).

## Rule touchpoints

`RP-1`/`RP-2` (a named, versioned fourth kind); `B-2` (the seam answers, this module never
fetches); `B-3`/`B-3b` (`ensureDir`/`exists` joined the seam, no new seam file); `SEC-4`
(model output is data: no path, no markup, no eval); `SEC-7` (id checked before any path is
built); `SEC-9`/`A-7` (rate limits, iteration cap, session and message caps, all named);
`T-1`/`T-2` (validated twice, never trusted from a previous answer); `E-1` (expected
refusals are typed values: `SESSION_NOT_FOUND`, `PROPOSAL_NOT_SET`, `PROPOSAL_INVALID`);
`OBS-3` (provider calls logged by length and latency, never by content); `D-1`/`D-3` (the
clock is injected for session timestamps, `updatedAt` is ISO UTC); `D-4` (`performance.now`
for latency); `H-2` (every refusal is a `code`); `H-5` (the route lives in the table);
`DOC-3`/`DOC-4` (this note, and the `AGENTS.md` kind list updated in the same change).
