# BUG-007: System Crashes from Non-Essential Module Errors

- **Severity**: HIGH
- **Status**: ✅ Documented (process fix, not code fix)
- **Fixed In**: — (governance standard)
- **Related Files**: Architecture-wide

## Symptoms

An error in a non-essential module (e.g., logging, UI rendering, capability caching) caused the entire system to crash. The simulation could not recover without a full restart.

## Root Cause

The system lacked error boundaries at module integration points. Errors propagated uncaught through the call stack, crashing the entire process instead of degrading gracefully.

## Fix (Process)

Documented the mandatory graceful degradation requirement in `wiki/code_quality_and_best_practices.md` Section 3.1:

> **Graceful Degradation (Fail-Safe)**: The system must not crash due to an error in a non-essential module. Use `try...catch` blocks at critical integration points, especially when dealing with LLM responses. Implement a detailed logging system (`INFO`, `WARNING`, `ERROR`, `CRITICAL`) to track runtime failures.

## Prevention

- Wrap all external integrations (LLM calls, file I/O, network requests) in `try...catch` blocks
- Implement circuit breaker patterns for non-essential services
- Use the centralized `Logger` utility (`src/utils/Logger.js`) for structured error logging
- Design modules to be independently recoverable — one module's failure should not cascade

## References

- Related wiki: `wiki/subMDs/error_handling.md`
- Related wiki: `wiki/code_quality_and_best_practices.md` Section 3.1
- Related bug: [BUG-002](../critical/BUG-002-malformed-consequence-error.md)
- Related bug: [BUG-006](../high/BUG-006-schema-validation-gap.md)