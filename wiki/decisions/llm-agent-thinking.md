# Decision: the NPC agent round sends `enable_thinking`, and the default is off

Date: 2026-11-01 (recorded in the commit that implements this)

## Context

The world fires an LLM call for every NPC every round (`LLMAgentController.runRound` ->
`LLMController.chatFull`). On the backend this repo actually runs - `llama.cpp` serving a
`Qwen3.8-Flash-Next-UD-Q3_K_XL` GGUF - that call reasons before it acts, and nobody ever
asked it to. It is the server's default, so the reasoning arrived unannounced and the code
adapted to it instead: `LLM_ROUND_MAX_TOKENS` is 51200 because "a long 'think carefully' turn
can burn tens of thousands of thinking tokens", `LLM_ROUND_TIMEOUT_MS` is 450 s for the same
reason, and the transcript replays `reasoning_content` back to the model because reasoning
models expect their own reasoning in multi-turn. Three knobs were sized around a behaviour
that was never chosen.

The operator asked for one `.env` variable to switch that behaviour, default off. Three things
had to be decided, and only one of them was answerable from the repository.

## Which spelling on the wire (measured, not assumed)

OpenAI-compatible servers disagree about how to say "do not reason", and the dangerous
failures are the ones that answer 200. Measured against the running backend, four minimal
requests, `max_tokens: 16`, one prompt:

| body | `reasoning_content` in the reply | latency |
| --- | --- | --- |
| nothing (what the repo sent until now) | present, 64 chars | 3.6 s |
| `chat_template_kwargs: { enable_thinking: false }` | **absent** | **0.5 s** |
| `chat_template_kwargs: { thinking: false }` | present | 1.3 s |
| `reasoning_effort: "none"` | present | 1.1 s |

Only `enable_thinking` works. The other two are the trap: a 200, a well-formed response, and
the model still reasoning - an operator who set one of those would report "the variable does
nothing" and be right, with nothing in the logs to show why. Note that the wrong spellings are
not equally slow: `{ thinking: false }` and `reasoning_effort` both came in around 1.1-1.3 s,
faster than the unadorned 3.6 s, so even timing does not reliably reveal that the flag was
ignored (the model was warm, the prompt trivial - the discriminator is
`reasoning_content`, not the clock).

So the wire shape is settled by measurement, and the code records it at the assembly site
(`LLMController.chatFull`): `chat_template_kwargs: { enable_thinking: <boolean> }`.

## Scope: the agent round, not every LLM call

`chatFull` is the single body builder for all three prompt kinds (room chat, the NPC agent
round, `agent-body-design`). Putting the gate inside it would have made one variable control
all three, and that is wrong in one specific direction: the body designer was tuned *for*
thinking. `LLM_AGENT_BODY_MAX_TOKENS` is ten times the general default, and its comment says
the precision reasoning model counts thinking tokens against the cap and a smaller budget
truncated the design. A global switch off would silently degrade a path that somebody sized
on purpose, while looking like a config change.

The gate therefore lives in `LLMAgentController`, and `LLMController` only gains the
*capability*: `options.thinkingEnabled` maps to the kwarg when it is a boolean, and when it is
absent the payload does not mention reasoning at all. Room chat and body design send exactly
the body they send today, byte for byte, and a server that does not know `chat_template_kwargs`
is never sent one.

## Default off means the request says `false`, not that the field is absent

Two readings of "default off": send nothing until somebody opts in (a tri-state: absent /
true / false), or send `false` and let `=true` be the only way to get reasoning. The operator
chose the latter, and it is the literal one. The consequence is stated here because it is a
behaviour change on a running world: **an NPC round that used to reason no longer does**, with
nothing set at all. That is what was asked for, and it is also the reading under which the
variable means what it says - a knob that is off does not mean "the server decides".

## Read per round, not once at boot

`LLMController` resolves `LLM_ENDPOINT` / `LLM_MODEL` / `LLM_TIMEOUT_MS` inside `chatFull`, on
every call; `KILLER_LLM_DRONE_ENABLED` is read once, at spawn. The thinking gate follows the
first precedent: the round is a per-call event and the gate is exactly the thing you flip
between rounds to compare what an NPC does with and without reasoning, so `isAgentThinkingEnabled()`
is called where the round's `options` are assembled. (`.env` itself is loaded by dotenv at boot,
so editing the file still needs a restart; `export` does not.)

## What was deliberately left alone

- **`reasoning_content` replay.** The transcript keeps replaying whatever reasoning the provider
  produced. With thinking off, new rounds produce none, so the replay goes quiet on its own;
  only the rounds a flip straddles still carry old reasoning. Changing the replay to match the
  gate would couple two things and would break the multi-turn contract the existing comment
  documents, for a saving limited to the transition.
- **`LLM_ROUND_MAX_TOKENS` / `LLM_ROUND_TIMEOUT_MS`.** Not lowered for the off state. They are
  sized for the state where the operator turns thinking on, and lowering them would mean
  raising them again on the first opt-in - and a cap that truncates reasoning mid-thought is the
  failure the comments describe.
- **Room chat, body design.** See scope above. Not gated, not touched.

## Open questions

1. `enable_thinking` is the llama.cpp / HF-Qwen3 spelling. A different backend (a hosted
   endpoint, a DeepSeek-style model that cannot stop reasoning) may want a different kwarg or
   none. Nothing today expresses "which backend am I talking to"; one variable per backend, or a
   small mapping, is the honest fix if this repo ever points at a second server.
2. Whether per-kind gates are wanted after all (a body-design gate, a chat gate) - see
   `AGENTS.md` prompt kinds. Deliberately not built now: two knobs to explain for a need nobody
   has stated yet.
