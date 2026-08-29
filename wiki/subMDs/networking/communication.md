# Communication and Error Handling

## 1. LLM Integration

### Why LLM Responses Must Be Validated

LLM responses are untrusted external data. The Chat Completion API is a third-party service that can return malformed, incomplete, or adversarial payloads. **Every response must be validated before consumption** to prevent cascading failures when the LLM returns unexpected structures. Validation is the single defense against corrupted data entering the game state.

### Why Centralized LLM Interaction

Centralizing LLM interaction in one controller prevents scattered HTTP logic, inconsistent timeout handling, and duplicated validation. Without this, every caller would reimplement their own error handling, leading to divergent behavior and silent failures.

## 2. Error Handling Philosophy

Error handling is **layered**: validation errors are caught early at the API boundary, network errors are classified by recoverability, and application-level errors propagate with structured codes. This layering exists because:

- **Different error types require different responses**: A validation error should reject the input; a network error should retry; an application error should log and propagate
- **Structured codes enable client awareness**: The client can distinguish "retry this" from "this will never work" without parsing error messages

## 3. Error Classification

| Layer | Error Type | Action |
|-------|-----------|--------|
| Validation | Malformed structure | Reject input, request correction |
| Network | Connection failure | Classify as recoverable or terminal |
| Application | Business rule violation | Log, propagate to caller |

## 4. Turn Signals & Barrier State on the Wire

Players have no tick-driven agent, so the planning barrier can only know the human side is finished through an explicit **ready endpoint** (per entity id); there is no deadline, so a player who never signals delays the round indefinitely (by design — the wait is made visible through the barrier state instead of being hidden behind a timer). The round state carries an additive **barrier** section (roster/ready/close information) in both the full-state turns block and the dedicated round-update event, and the planning-phase full-state broadcast is change-gated (it fires only when the barrier view actually changes). Additive, not replaced: existing clients that ignore the new section keep working, and the barrier display is informational only (who is still planning, when planning closed, and why).