# BUG-107: Typed ID System Partially Adopted — Gaps in Capability Controller, Routes, Broadcast, Frontend

- **Severity**: MEDIUM
- **Status**: ⚠️ Known
- **Fixed In**: `pending`
- **Related Files**: `src/controllers/capabilities/componentCapabilityController.js`, `src/controllers/WorldStateController.js`, `src/routes/*.js`, `src/services/WorldStateBroadcastService.js`, `public/js/*.js`

## Symptoms

The typed ID system exists (`ent-`, `comp-`, `item-`, `eq-` prefixes) but is not consistently used across all system areas. This creates a fragmented experience where:
- Some parts of the system generate typed IDs
- Other parts expect raw UUIDs
- No validation ensures IDs are in the correct format
- Frontend treats all IDs as opaque strings

## Root Cause

Typed IDs were added to the codebase (`idGenerator.js`, `IdResolver.js`) but the integration was never completed. The following areas were not updated:
- ComponentCapabilityController: Uses raw IDs in capability entries
- WorldStateController public methods: Don't handle typed IDs
- Route files: No ID validation
- WorldStateBroadcastService: Broadcasts raw IDs
- Frontend files: Treat IDs as opaque strings

## Prevention

- [ ] ComponentCapabilityController: Add typed IDs to capability entries
- [ ] WorldStateController: Add typed ID public methods
- [ ] Routes: Add ID validation
- [ ] BroadcastService: Broadcast typed IDs
- [ ] Frontend: Update to handle typed IDs

## References

- Related wiki: `wiki/subMDs/systems/typed_id_adoption.md`
- Related controller: `IdResolver`, `idGenerator`
- Related bug: `wiki/bugfixWiki/architectural/BUG-106-missing-typed-id-system.md`