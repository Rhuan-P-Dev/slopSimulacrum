# BUG-034: DataLoader.loadJsonSafe Silently Swallows Errors

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/utils/DataLoader.js` (lines 38-44)

## Symptoms
- When a JSON config file fails to load, the system silently falls back to defaults
- No log message indicates which file failed to load
- Debugging missing config files is difficult because failures are invisible

## Root Cause
```javascript
static loadJsonSafe(relativePath, defaultValue = {}) {
    try {
        return this.loadJson(relativePath);
    } catch (error) {
        return defaultValue; // ⚠️ Silent swallow - error never logged
    }
}
```
The `catch` block returns `defaultValue` without any logging.

## Fix
Added `Logger.warn()` call before returning the default value:
```javascript
} catch (error) {
    Logger.warn(`[DataLoader] Failed to load ${relativePath}, using default: ${error.message}`);
    return defaultValue;
}
```

## Prevention
- Never silently swallow errors in production code
- Use the centralized `Logger` utility for all logging
- Document expected failure modes for utility functions

## References
- Related wiki: `wiki/subMDs/error_handling.md`
- Related utility: `src/utils/Logger.js`