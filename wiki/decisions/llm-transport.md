# Decision: the LLM seam carries its own `node:http` transport; `globalThis.fetch` is out of the LLM path

Date: 2026-11-06

Status: accepted and implemented in this change.

## The bug this is about

The operator reported `❌ ERROR [LLMController] Communication failure: fetch failed` while
`LLM_TIMEOUT_MS` was set to `3000000` (50 minutes), and asked for that timeout to be 10x
larger. Two facts did not fit together, so the behavior was measured before anything was
changed.

## Context (measured on Node 24.13.1, undici 7.18.2)

- **The error is not our timeout.** A budget exhausted through our own `AbortController`
  falls in the `AbortError` branch and logs `Request timed out after Xms` with code
  `LLM_TIMEOUT`. The reported line is the *other* branch — `LLM_REQUEST_ERROR`, a transport
  failure — and it printed only `error.message`, which for every transport failure is the
  bare string `fetch failed`. The reason lives in `error.cause`, which was dropped.
- **The transport has its own header cutoff, and it wins.** Against a local server holding
  response headers for 330 s:

  | Client shape | Result |
  | --- | --- |
  | `AbortController` + `setTimeout(420 s)` (what `LLMController._executeRequest` did) | dies at **300.7 s**, `cause = HeadersTimeoutError / UND_ERR_HEADERS_TIMEOUT` |
  | `AbortSignal.timeout(420 s)` | dies at **300.7 s** — the budget is *not* aligned to the signal |
  | `fetch(url, { headersTimeout, bodyTimeout })` | **options ignored** — a 300 ms header timeout did not fire on a 1.2 s response |

  So for a non-streaming response, `LLM_TIMEOUT_MS` above ~300 s was a lie: the client under
  `fetch` cut the request at 5 minutes, and that arrived as `LLM_REQUEST_ERROR: fetch failed`.
  A local reasoning model exceeds 5 minutes routinely. `LLM_ROUND_TIMEOUT_MS = 450000`
  (`src/controllers/networking/LLMAgentController.js:63`) was unreachable by construction.
- **The backend was healthy** the whole time: `http://localhost:6030/v1/models` and
  `http://127.0.0.1:6030/v1/models` answer 200 in ~10–70 ms; only `[::1]:6030` is refused
  (the inference server binds IPv4). So the failure was not a dead endpoint.
- **`undici` is not importable** (`ERR_MODULE_NOT_FOUND`) — Node bundles it but does not
  expose it, so `setGlobalDispatcher(new Agent({ headersTimeout }))` would require a new
  runtime dependency.

## Options considered

1. **`undici` dependency + `setGlobalDispatcher`.** The direct fix for the 300 s knob.
   Rejected: the runtime set is `express` / `socket.io` / `dotenv`, and spending it is a
   `SEC-8` decision, not a timeout fix. The operator refused it explicitly.
2. **A `node:http` / `node:https` client for this one call** — built-in, no dependency, and
   the caller owns the timeouts. **Chosen.**
3. **`stream: true`.** Headers would arrive immediately so the cutoff could not fire, and
   `bodyTimeout` becomes an inactivity timer. Rejected for this change: SSE parsing in the
   seam, and `tool_calls` reassembly arrive in pieces — a change to the response contract,
   much larger than the bug.
4. **Fit inside 300 s** (`LLM_ROUND_TIMEOUT_MS` down to ≤ 300000, shorter caps). Rejected:
   keeps the ceiling that is being hit.

## Decision

`src/utils/HttpClient.js` is the server's outbound JSON-over-HTTP client:

- `requestJson(url, init)` is deliberately **fetch-shaped** — `(url, { method, headers, body,
  signal })` resolving to `{ ok, status, statusText, json(), text() }` — so the seam's error
  mapping reads as it always did. It is not a polyfill: one absolute http(s) URL, no redirect
  following, no cookies, no streaming.
- It sets `headersTimeout: 0` and `requestTimeout: 0` and passes the caller's `signal`. The
  caller's deadline is therefore the *only* timeout, and — unlike the old shape — it covers
  the body as well as the headers.
- `LLMController` takes it through the constructor (`new LLMController({ transport })`), so
  tests inject a fake instead of patching `globalThis.fetch`. Default parameter = production
  transport; `src/server.js` is unchanged.
- `buildRequestOptions` is exported so a test can pin the two zeroed knobs (see below).

Recorded alongside: the failure log now carries the projected cause (`OBS-1`), so
`fetch failed` can never again be the whole story — it logs
`| Context: {"name":"HeadersTimeoutError","code":"UND_ERR_HEADERS_TIMEOUT", ...}`, with the
`AggregateError` attempts and the refusing `address`/`port` unwrapped.

## Consequences

- `LLM_TIMEOUT_MS` is now the real ceiling. With the operator's `3000000`, the ceiling moved
  from 300 s to 3000 s — the 10x that was asked for, obtained without a dependency.
  `LLM_ROUND_TIMEOUT_MS` (450 s) is reachable for the first time.
- **`cr/fetch-requires-signal` (E-5) no longer covers the LLM call**, because there is no
  `fetch(` call left in `src/`. The rule keeps guarding any future `fetch`. The intent is
  pinned by tests instead: `test/unit/LLMController.chatFull.test.js` asserts the transport
  receives a live `signal` and no timeout knob of its own, and `test/unit/HttpClient.test.js`
  asserts `headersTimeout === 0 && requestTimeout === 0` plus a body-stall case that a
  header-only timeout would have hung on. Adding a `cr/*` rule for the transport instead of
  these tests was not done — a new rule needs its fixture first, and one commit of its own.
- Redirects are no longer followed: a 3xx resolves as a non-`ok` response and the seam maps
  it to `LLM_HTTP_ERROR`. Nothing in the OpenAI-compatible path redirects.
- Response bodies remain uncapped (parity with `Response.json()`), so a hostile backend could
  stream without bound. Not changed here; the endpoint is operator-configured.
- `Content-Length` is set explicitly (Node would otherwise send the request chunked, which an
  OpenAI-compatible server is not required to accept).
- The downstream error contract is byte-identical: same `LLMError` codes, same messages,
  `cause` still attached. Only the log line grew.
- Local planning note: `.env.example` and the class header now say the budget is honored, so
  nobody sets `LLM_TIMEOUT_MS` to a number the transport cannot use again.

## Verification

- `npm run check` — lint + `check:lang` + `vitest run`: **164 files, 2255 passed, 1 skipped**.
  Two migrated suites: `LLMController.chatFull` (transport injected) and `LLMAgentThinking`
  (the wire test injects its own transport instead of patching `globalThis.fetch`); new
  `test/unit/HttpClient.test.js` (10 tests) runs against a real `node:http` server on
  127.0.0.1, including a slow-header case and a stalled-body case.
- Against the real backend through the new transport: `GET /v1/models` → `200 OK`; one
  `LLMController.chatFull` round → `{"content":"ok","finishReason":"stop"}` in 4794 ms.
- Not verified: a live call that actually runs past 300 s (the case that motivated this) —
  it needs a real long generation. The unit test reproduces the shape at millisecond scale
  (`SLOW_HEADERS_MS`) rather than at 5 minutes.

## Open

- Whether a long round should now also raise `LLM_LOG` verbosity per kind (`OBS-3` latency
  logging exists for rounds; per-call provider latency is not logged on this path).
- If a second external HTTP seam ever appears, it uses this client — not `fetch` — so it
  inherits the same single-deadline discipline.
