# BUG-033: Synergy Cache Never Expires

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/synergyController.js` (lines 123-124, 215-218)

## Symptoms
- Synergy results are cached indefinitely even when world state changes
- Stale synergy multipliers are returned for actions executed after component stats have changed
- Cache grows unbounded with no eviction policy

## Root Cause
1. **TTL Never Checked**: Line 124 set `this._cacheTtlMs = 5000`, but no code reads the timestamp (line 217: `timestamp: Date.now()`) to invalidate stale entries. The cache effectively never expires.
2. **Cache Never Read**: `_synergyCache.get()` was never called — cache was write-only. No `getCachedSynergy()` method existed.
3. **No Size Limit**: No maximum entry count, allowing unbounded memory growth.

## Fix
1. Added `getCachedSynergy(actionName)` method that checks `Date.now() - entry.timestamp > this._cacheTtlMs`
2. Added `clearCache()` public method
3. Added `_cacheSet(actionName, result)` private method with TTL and size eviction (`SYNERGY_CACHE_MAX_SIZE = 100`)
4. Imported `SYNERGY_CACHE_TTL_MS` and `SYNERGY_CACHE_MAX_SIZE` from `Constants.js`
5. Replaced hardcoded `this._cacheTtlMs = 5000` with constant

## Prevention
- Always validate cache TTL in both read and write paths
- Add unit tests for cache expiration behavior
- Use `structuredClone()` for deep copies, not `JSON.parse(JSON.stringify())`

## References
- Related wiki: `wiki/subMDs/synergy_system.md`
- Related controller: `SynergyController`
- Constant added: `src/utils/Constants.js` — `SYNERGY_CACHE_TTL_MS`, `SYNERGY_CACHE_MAX_SIZE`