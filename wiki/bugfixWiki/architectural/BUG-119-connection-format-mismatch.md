# BUG-119: Connection Storage Format Mismatch Between Branches

- **Severity**: ARCHITECTURAL
- **Status**: ✅ Fixed
- **Fixed In**: `commit unknown` (merge of `map-door-click-range` into `main`)
- **Related Files**: `src/utils/WorldGraphBuilder.js`, `public/js/WorldMapView.js`, `src/controllers/core/RoomsController.js`, `public/js/RoomConnectionRenderer.js`, `public/js/App.js`

## Symptoms

Merging the `map-door-click-range` branch into `main` produced **10 conflict blocks across 3 files** because the two branches independently evolved incompatible connection data formats. Consumers of connection data broke silently when receiving the unexpected format, as neither branch validated the structure they received from the other.

Specifically, the World Map arrow rendering failed because `WorldGraphBuilder.build()` stored `targetId` as an object `{ target: "room_id" }` instead of extracting the raw room ID string. The client-side `WorldMapView` then attempted to look up rooms using this object reference against the room index, which only keyed by string IDs — resulting in every connection resolving to `undefined` and no arrows rendering.

## Root Cause

The project lacked a stable, enforced contract for the internal connection storage format. Two branches independently chose different representations:

- **main (HEAD)** used a flat string format: `connections[door] = "uid"` — optimized for simple room-to-room lookups without metadata.
- **map-door-click-range** used an object format: `connections[door] = { target: "uid" }` — aligned with the wiki's extensible design and the actual `data/rooms.json` structure.

Both formats were functionally correct within their own branch but incompatible when combined. The absence of a single source of truth for the connection format meant each branch evolved in isolation, assuming their format was the canonical one. This violated the project's "Single Source of Truth" constraint from [Project Rules](../project_rules.md) Section 2, where state format should be determined by the root controller's public API contract.

The deeper issue is that `WorldGraphBuilder` — as a consumer of room connection data — had no defense against receiving either format. It blindly passed through whatever `connData` it received from the rooms controller, trusting a single format without validation. This is why the mismatch went undetected: the builder acted as a pass-through rather than a normalizer, propagating the format inconsistency to every downstream consumer (the World Map view, room connection renderer, etc.).

Additionally, the wiki's [`rooms_controller.md`](../subMDs/controllers/rooms_controller.md) had already specified the object format as the target design with `getConnectionTarget()` as the designated accessor — but main's implementation skipped this accessor and read connections directly, creating a divergence from documented architecture.

## Fix

The merge resolution implements dual-format handling for backward compatibility while standardizing on the object format as the canonical internal representation. All connection consumers now extract the target UID defensively using a type check rather than assuming a specific structure. The `getConnectionTarget()` accessor from the wiki design was adopted as the primary access pattern, eliminating direct property access on the connections map.

In `WorldGraphBuilder`, normalization was added at the connection iteration point so that the builder produces consistent string `targetId` values regardless of the input format. This ensures the World Map view receives room IDs it can actually look up, restoring arrow rendering. The normalization pattern in the builder matches the same defensive extraction already used in `RoomConnectionRenderer`, reinforcing a consistent approach across all connection consumers.

## Prevention

Future data format changes must go through a coordinated migration rather than independent branch evolution:

1. **Contract stability**: The internal data format for shared structures (like connections) must be locked before feature branching. The wiki specification serves as this contract.
2. **Accessor enforcement**: Consumers must use designated accessors (`getConnectionTarget()`) rather than directly reading internal state, so format changes are contained to a single method.
3. **Format validation**: When loading data from `rooms.json`, the controller should normalize all connections to the canonical format immediately, preventing dual-format consumers from ever seeing legacy structures.

## References

- Related wiki: `wiki/subMDs/controllers/rooms_controller.md`
- Related wiki: `wiki/subMDs/systems/door_range_system.md`
- Related plan: `plans/merge-conflict-resolution-plan.md`
