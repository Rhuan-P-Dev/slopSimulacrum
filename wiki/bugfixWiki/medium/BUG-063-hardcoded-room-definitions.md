# BUG-063: Hardcoded Room Definitions in RoomsController

- **Severity**: MEDIUM
- **Status**: ✅ Fixed
- **Fixed In**: `3267ec8` (feat: add world map overlay UI and update controller docs)
- **Related Files**: `src/controllers/core/RoomsController.js`, `data/rooms.json`

## Symptoms

Room definitions were hardcoded directly inside `RoomsController.js` constructor, violating the project's data loading pattern. All other game data (actions, components, blueprints, traits, synergy) is loaded from external JSON files via `DataLoader`, but room definitions were an exception.

This caused:
- Inconsistency with the established data loading pattern used throughout the codebase
- Difficulty adding/modifying rooms without code changes (no hot-reload of data)
- Violation of the Single Responsibility Principle (SRP) — controller handled both data interpretation and data embedding

## Root Cause

The `RoomsController` constructor contained a hardcoded `roomDefinitions` object with literal room data. This deviated from the pattern used by `WorldStateController`, which loads all data via `DataLoader.loadJsonSafe()` — room definitions were the only game data not externalized to a JSON file.

## Fix

Room definitions were externalized to `data/rooms.json` so that rooms can be added or modified as data rather than through code changes. `RoomsController` now loads the file via `DataLoader.loadJsonSafe()`, validates it with the standard `_validate*()` pattern before initialization, and logs the initialization count via `Logger` — aligning room handling with the data loading standard used by every other state controller.

## Prevention

- All game data must be loaded via `DataLoader` — no hardcoded data objects in controllers
- Controllers must validate external data before use (`_validate*` pattern)
- Use ESLint rule `no-restricted-syntax` to flag hardcoded data literals in constructor bodies
- Code review checklist item: verify new data sources use `DataLoader.loadJsonSafe()`

## References

- Related wiki: `wiki/CORE.md` (Logging Standard, line ~77; Data Loading Standard, line ~80)
- Related wiki: `wiki/code_quality_and_best_practices.md` Section 3.2 (Schema Validation)
- Related wiki: `wiki/subMDs/controller_patterns.md` Section 8.1 (RoomsController Pattern)
- Related controller: `WorldStateController` (uses `DataLoader.loadJsonSafe()` for all data)
- Related utility: `src/utils/DataLoader.js`
