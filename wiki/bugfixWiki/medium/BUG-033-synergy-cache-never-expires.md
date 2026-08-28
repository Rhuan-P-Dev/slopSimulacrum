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
1. **TTL Never Checked**: each cache entry's timestamp was written, but nothing ever read it to invalidate stale entries — the TTL existed only in name, so the cache effectively never expired.
2. **Cache Never Read**: the cache had no read path (write-only; no `getCachedSynergy()` method existed), so cached results were never actually returned.
3. **No Size Limit**: no maximum entry count, allowing unbounded memory growth.

## Fix
The cache now has a proper read path: entries are returned only while fresh (TTL checked at read time), a maximum size with eviction bounds memory growth, and TTL/size are named constants in `Constants.js` instead of hardcoded values. A public `clearCache()` provides explicit invalidation when world state changes.

## Prevention
- Always validate cache TTL in both read and write paths
- Add unit tests for cache expiration behavior
- Use `structuredClone()` for deep copies, not `JSON.parse(JSON.stringify())`

## References
- Related wiki: `wiki/subMDs/synergy_system.md`
- Related controller: `SynergyController`
- Constant added: `src/utils/Constants.js` — `SYNERGY_CACHE_TTL_MS`, `SYNERGY_CACHE_MAX_SIZE`