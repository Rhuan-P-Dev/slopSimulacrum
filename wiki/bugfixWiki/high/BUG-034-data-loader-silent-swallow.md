# BUG-034: DataLoader.loadJsonSafe Silently Swallows Errors

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `src/utils/DataLoader.js` (lines 38-44)

## Symptoms
- When a JSON config file fails to load, the system silently falls back to defaults
- No log message indicates which file failed to load
- Debugging missing config files is difficult because failures are invisible

## Root Cause
`loadJsonSafe()` caught load failures and returned the default value with no logging at all, so a missing or corrupt config file was indistinguishable from an intentionally empty one.

## Fix
A `Logger.warn()` call now emits which file failed and why before the fallback default is returned. The fallback itself was deliberately kept — the system must still boot with defaults when a config file is missing — but the failure is no longer invisible.

## Prevention
- Never silently swallow errors in production code
- Use the centralized `Logger` utility for all logging
- Document expected failure modes for utility functions

## References
- Related wiki: `wiki/subMDs/error_handling.md`
- Related utility: `src/utils/Logger.js`