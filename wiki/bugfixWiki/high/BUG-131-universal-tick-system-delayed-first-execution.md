# BUG-131: UniversalTickSystem Jobs Delayed by One Interval on First Execution

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown`
- **Related Files**: `src/utils/UniversalTickSystem.js`

## Symptoms

Tick jobs registered with UniversalTickSystem do not execute on their first expected interval. For example, a job with interval=5 ticks does not fire until tick 5 instead of tick 0, causing a delay of one full interval before the job's first execution.

## Root Cause

In the `start()` method, `currentTick++` was called BEFORE `_executeTick()` in the setInterval callback. Since `currentTick` starts at 0, the first execution happens at tick 1 (where `1 % N !== 0` for most intervals), delaying job execution until the first interval boundary is reached.

## Fix

Reordered the setInterval callback so `_executeTick()` runs BEFORE `currentTick++`, ensuring the first execution happens at tick 0 where `0 % N === 0` for any interval N.

## Prevention

When using modulo-based scheduling, ensure the initial tick value aligns with expected scheduling behavior. Consider adding unit tests for tick 0 execution.

## References
- Related wiki: `wiki/subMDs/` (tick system documentation)
