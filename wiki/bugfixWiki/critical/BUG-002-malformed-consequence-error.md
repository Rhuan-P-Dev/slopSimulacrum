# BUG-002: CRITICAL Error — Malformed Consequence Data Access

- **Severity**: CRITICAL
- **Status**: ✅ Fixed
- **Fixed In**: `b53e0dd` ("fix: filter only source components as attackers and add safety checks")
- **Related Files**: `src/controllers/actionController.js` (lines 208-209)

## Symptoms

When a consequence handler encountered an error and the catch block tried to log the error:
- The catch block accessed `consequence?.type` and `consequence?.params?.message` without proper null checking
- If consequence data was malformed or undefined, this caused a **CRITICAL error** that crashed the action execution
- Error logging itself crashed, making debugging nearly impossible

## Root Cause

The catch block in `_executeMultiAttackerConsequences()` accessed nested properties on potentially undefined objects. If `consequence` was undefined or `consequence.type` was null, the error logging itself threw an additional error on top of the original failure.

## Fix

Error logging now degrades gracefully: consequence fields are read defensively with fallback values, so a malformed or undefined consequence record is logged with a placeholder instead of throwing a second error. Rationale: a logging path in an error handler must never be able to mask the original failure it is reporting.

## Prevention

- Always use optional chaining (`?.`) when accessing nested properties on external data
- Provide fallback values with `||` for critical logging paths
- Validate consequence data structure before processing
- Follow the **Graceful Degradation** principle from `wiki/code_quality_and_best_practices.md` Section 3.1

## References

- Related wiki: `wiki/subMDs/action_system.md`
- Related wiki: `wiki/subMDs/error_handling.md`
- Related controller: `ActionController`
- Git commit: `b53e0dd`
- Related bug: [BUG-007](../high/BUG-007-graceful-degradation.md)