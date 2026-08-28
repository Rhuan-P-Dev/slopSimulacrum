# BUG-009: Server Direct Sub-Controller Access

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: — (architectural fix)
- **Related Files**: `src/server.js`, `src/controllers/WorldStateController.js`

## Symptoms

The server (`server.js`) accessed sub-controllers directly instead of using `WorldStateController` public API methods. This caused:
- Tight coupling between server and internal controller structure
- Breakage when internal controller structure changed
- Bypassed validation logic in the root controller

## Root Cause

The `WorldStateController` did not expose public wrapper methods for common operations. Server code reached into internal controller properties to perform actions.

## Fix

Added public API wrapper methods on `WorldStateController` (`spawnEntity`, `despawnEntity`, `moveEntity`, `getRoomUidByLogicalId`) so the server can drive world changes exclusively through the root controller. The wrappers exist for two reasons: they keep the server decoupled from internal sub-controller structure (so refactoring internals cannot break the server), and they guarantee every world change passes through root-level validation instead of bypassing it.

## Prevention

- Controllers must communicate via **Public APIs** only
- Never access another controller's internal variables (`this.entities`, `this.roomsController`, etc.)
- Follow the **Loose Coupling** principle from `wiki/code_quality_and_best_practices.md` Section 1.2
- Refer to `wiki/subMDs/controller_patterns.md` Section 5.1 for Server API Access rules

## References

- Related wiki: `wiki/subMDs/controller_patterns.md` Section 5.1
- Related wiki: `wiki/map.md` Section 5.1
- Related controller: `WorldStateController`
- Related bug: [BUG-017](../architectural/BUG-017-dual-state-bug.md)