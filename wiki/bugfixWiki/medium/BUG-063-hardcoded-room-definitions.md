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

The `RoomsController` constructor contained a hardcoded `roomDefinitions` object with literal room data:

```javascript
const roomDefinitions = {
    'start_room': {
        name: 'The Entrance Hall',
        description: 'A dimly lit hall...',
        connections: { 'right_door': 'right_room' },
        x: 200, y: 250, width: 300, height: 200
    },
    // ... more hardcoded rooms
};
```

This deviated from the pattern used by `WorldStateController`, which loads all data via `DataLoader.loadJsonSafe()`.

## Fix

1. **Created `data/rooms.json`** — externalized room definitions to a JSON data file, following the same format as `data/actions.json`, `data/components.json`, etc.

2. **Updated `RoomsController.js`** — replaced hardcoded definitions with `DataLoader.loadJsonSafe('data/rooms.json', {})`

3. **Added `_validateRoomDefinitions()` method** — validates all loaded room definitions before initialization, checking:
   - `name` is a non-empty string
   - `description` is a string
   - `connections` is an object with string door names and string target IDs
   - `x`, `y` are numbers
   - `width`, `height` are numbers

4. **Added `Logger` import** — per wiki/CORE.md logging standard, logs initialization count on success.

### Before:
```javascript
import { generateUID } from '../../utils/idGenerator.js';

class RoomsController {
    constructor() {
        const roomDefinitions = { /* hardcoded */ };
        // ...
    }
}
```

### After:
```javascript
import { generateUID } from '../../utils/idGenerator.js';
import DataLoader from '../../utils/DataLoader.js';
import Logger from '../../utils/Logger.js';

class RoomsController {
    constructor() {
        const roomDefinitions = DataLoader.loadJsonSafe('data/rooms.json', {});
        this._validateRoomDefinitions(roomDefinitions);
        // ...
        Logger.info(`[RoomsController] Initialized with ${Object.keys(this.rooms).length} rooms`);
    }

    _validateRoomDefinitions(defs) {
        // Validation logic...
    }
}
```

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
