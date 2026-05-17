# Internal Components System

## Overview

The Internal Components system allows components to contain other components internally, using a volume-based capacity model. Each internal component can have its own effects — the `durabilityRepairSphere` is the first internal component, automatically installed on every non-finger component of the smallBallDroid, healing its host component's durability by +1 every 5 seconds.

### Design Rationale

- **Why volume-based capacity?**: Volume provides an intuitive physical constraint — larger components can contain more internal components. This prevents invalid configurations (e.g., a finger containing a large repair sphere).
- **Why `humanoidDroidFinger` excluded?**: Fingers are small, precision components (volume: 4) that represent fine motor control. Adding internal components would clutter the UI and serve no gameplay purpose.
- **Why 5-second repair interval?**: Matches the CSS pulsing animation cycle, creating visual consistency between server repair ticks and client-side rendering feedback.
- **Why auto-install on spawn?**: Ensures all smallBallDroid entities start with repair capability without manual configuration, reducing player complexity.

## Architecture

```mermaid
graph TD
    ICE[InternalComponentController] -->|uses| DL[DataLoader]
    ICE -->|triggers| CC[ComponentController.updateComponentStatDelta]
    ICE -->|stores| IC[internalComponents map]
    SEC[stateEntityController] -->|auto-installs| ICE
    SEC -->|stores| IC
    WSC[WorldStateController] -->|self-instantiates| ICE
    WSC -->|aggregates| IC
    ICE -->|DI via| WSC2[setWorldStateController()]
    CV[ComponentViewer] -->|fetches| API[internalComponentRoutes]
```

## Data Model

### Internal Components Storage

```
internalComponents = {
    [entityId]: {
        [hostComponentId]: [
            {
                id: "internal-component-uid",
                type: "durabilityRepairSphere",
                hostComponentId: "host-component-uid",
                hostComponentType: "centralBall",
                hostComponentIdentifier: "default",
                installedAt: timestamp
            }
        ]
    }
}
```

### Volume System

Each component has a `volume` property in its `Physical` trait representing its internal capacity. Each internal component has a `volume` property representing the space it occupies.

**Rule**: An internal component can only be installed if:
1. The host component's `Physical.volume` >= internal component's `volume`
2. The host component type is NOT in the internal component's `excludedComponentTypes` list

**⚠️ Volume Checking Scope**: Volume checking is enforced **only** during `autoInstallOnEntitySpawn()` (triggered when an entity spawns). The manual `addInternalComponent()` method does **not** perform volume validation — it accepts any component type that exists in the registry.

### Component Volume Reference

The following table lists all component volume values from `data/components.json`:

| Component Type | Volume | Notes |
|---------------|--------|-------|
| `centralBall` | 10 | Core component — largest capacity |
| `droidHead` | 8 | Head component |
| `droidArm` | 8 | Arm component — medium capacity |
| `droidHand` | 6 | Hand component — smaller capacity |
| `droidRollingBall` | 12 | Rolling component — largest capacity |
| `humanoidDroidFinger` | 4 | Finger — smallest, excluded from internal components |

**Internal Component Volume Reference** (from `data/internalComponents.json`):

| Internal Component Type | Volume | Description |
|------------------------|--------|-------------|
| `durabilityRepairSphere` | 2 | Auto-installs on non-finger components, repairs +1 durability every 5 seconds |

**Volume Compatibility Examples**:
- `droidRollingBall` (volume: 12) can contain up to 6 `durabilityRepairSphere` instances (12 / 2 = 6)
- `centralBall` (volume: 10) can contain up to 5 spheres
- `droidArm` (volume: 8) can contain up to 4 spheres
- `droidHand` (volume: 6) can contain up to 3 spheres
- `humanoidDroidFinger` (volume: 4) can contain up to 2 spheres, but is **excluded** via `excludedComponentTypes`

### durabilityRepairSphere Definition

Located in `data/internalComponents.json`:

```json
{
  "durabilityRepairSphere": {
    "volume": 2,
    "repairInterval": 5,
    "repairAmount": 1,
    "traits": {
      "Physical": { "mass": 5, "durability": 50 }
    },
    "excludedComponentTypes": ["humanoidDroidFinger"],
    "autoInstallOnSpawn": true
  }
}
```

## Server-Side System

### InternalComponentController

**Type**: State Controller (self-instantiating with logic)

**Location**: `src/controllers/core/InternalComponentController.js`

**Key Methods**:
| Method | Parameters | Description |
|--------|-----------|-------------|
| `autoInstallOnEntitySpawn(entityId, components, componentVolumeProvider)` | `string`, `Array`, `Function\|null` | Auto-installs spheres on eligible components based on volume + exclusions. Returns `Array` of installed internal component instances. `componentVolumeProvider` is an optional function `(componentType) => number` for volume lookup |
| `addInternalComponent(entityId, hostComponentId, internalComponentType)` | `string`, `string`, `string` | Manually add an internal component; returns added component or null |
| `removeInternalComponent(entityId, hostComponentId, internalComponentInstanceId)` | `string`, `string`, `string` | Remove a specific internal component instance |
| `getInternalComponents(entityId, hostComponentId)` | `string`, `string` | Get internal components for a specific host (**defensive deep copy** via `structuredClone()`) |
| `getInternalComponentsForEntity(entityId)` | `string` | Get all internal components for an entity (**defensive deep copy** via `structuredClone()`) |
| `hasInternalComponent(entityId, hostComponentId, internalComponentType)` | `string`, `string`, `string` | Check if host has a specific internal component type |
| `cleanupEntity(entityId)` | `string` | Clean up all internal components when entity despawns |
| `startRepairSystem()` | — | Start the 5-second repair interval via `setInterval` |
| `stopRepairSystem()` | — | Stop the repair interval |
| `_processRepairTick()` | — | Execute one repair cycle across all entities |
| `setWorldStateController(worldStateController)` | `any` | DI setter — called by WorldStateController after initialization |
| `getAll()` | — | Return deep copy of all internal components via `structuredClone()` |

### Repair System

The repair system runs every 5 seconds (`setInterval(5000)`). Each tick:
1. `_processRepairTick()` iterates over all entities
2. For each entity's internal components, filters for `durabilityRepairSphere` type
3. Calls `ComponentController.updateComponentStatDelta()` on the host component
4. Increases `Physical.durability` by `repairAmount` (1 for durabilityRepairSphere)
5. The stat change triggers the broadcast system automatically via the existing listener
6. After repairs, `_syncToEntityStore()` syncs internal components back to entity store so client receives them in world-state broadcasts

**Private Methods**:
| Method | Description |
|--------|-------------|
| `_validateRegistry(definitions)` | Validates internal component type definitions — checks for required `volume`, `repairInterval`, `repairAmount` fields; throws `TypeError` if definitions is null/undefined or missing required numeric fields. Logs `Logger.warn()` for missing optional fields (`traits`, `excludedComponentTypes`) without throwing. |
| `_processRepairTick()` | Execute one repair cycle across all entities |
| `_syncToEntityStore()` | Syncs internal components from `this.internalComponents` storage back to `this.worldStateController.entityController.entities[entityId].internalComponents` for client world-state broadcasts |

### WorldStateController Integration

```javascript
// In constructor:
const internalComponentController = new InternalComponentController();
this.internalComponentController = internalComponentController;

// After initialization:
internalComponentController.startRepairSystem();

// In subControllers:
this.subControllers = {
    // ...
    internalComponents: this.internalComponentController,
    // ...
};
```

### WorldStateController Public API Methods (Internal Components)

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `addInternalComponent(entityId, hostComponentId, internalComponentType)` | `string`, `string`, `string` | `Object\|null` | Add an internal component to a host |
| `getInternalComponents(entityId, hostComponentId)` | `string`, `string` | `Array` | Get internal components for a host (**defensive deep copy**) |
| `getInternalComponentsForEntity(entityId)` | `string` | `Object` | Get all internal components for an entity (**defensive deep copy**) |
| `removeInternalComponent(entityId, hostComponentId, internalComponentInstanceId)` | `string`, `string`, `string` | `boolean` | Remove a specific internal component |
| `hasInternalComponent(entityId, hostComponentId, internalComponentType)` | `string`, `string`, `string` | `boolean` | Check if host has a specific internal component type |
| `cleanupInternalComponents(entityId)` | `string` | `boolean` | Clean up all internal components for an entity |
| `startInternalComponentRepairSystem()` | — | `void` | Start the repair system |
| `stopInternalComponentRepairSystem()` | — | `void` | Stop the repair system |

## Client-Side Rendering

### ComponentViewer Internal Components Panel

The `ComponentViewer` class provides a UI for viewing internal components. Internal components are displayed as part of the component detail panel, not as SVG map rendering.

**Rendering Details**:
- Internal components displayed within component cards in the ComponentViewer overlay
- Component cards with internal components show a 🔮 button to toggle expandable panel
- Internal component type badge (cyan color), description, host info, and metadata displayed in panel
- Pulsing animation: CSS keyframe animation (5s cycle matching repair interval)

**Key Methods**:
| Method | Parameters | Description |
|--------|-----------|-------------|
| `show(entityId, entity)` | `string`, `Object` | Loads entity and renders component grid with 🔮 buttons for components with internal components |
| `_onToggleInternalComponents(componentId, component)` | `string`, `Object` | Toggles expandable internal component panel for a component |
| `_renderInternalComponentPanel(component, internalComps, expanded)` | `Object`, `Array`, `boolean` | Renders internal component cards in expandable panel |

**Location**: `public/css/internal-components.css`

| CSS Class | Purpose |
|-----------|---------|
| **ComponentViewer Internal Components Panel** |
| `.internal-component-durability-repair-sphere` | Cyan fill (`#00ccff`), stroke (`#0099cc`), with 5s pulsing animation (`@keyframes internal-component-pulse`) |
| `.internal-component-tooltip` | Tooltip text overlay for internal component circles |
| **ComponentViewer Internal Components Panel** |
| `.component-internal-btn` | 🔮 button styling for toggling internal component panel |
| `.component-internal-container` | Container for internal component cards within ComponentViewer |
| `.internal-component-detail-card` | Individual internal component card styling |
| `.internal-component-detail-card:hover` | Hover state for internal component card (`background: rgba(0, 204, 255, 0.1)`, `border-color: rgba(0, 204, 255, 0.35)`) |
| `.internal-component-item` | Flex layout item with gap 8px, padding 2px |
| `.internal-component-badge` | Cyan color (`#00ccff`), bold |
| `.internal-component-info` | Text-dim color, 0.9em font-size |
| `.component-internal-btn:hover` | Filter brightness + scale transform on hover |
| `.internal-components-list` | List/container for rendering multiple internal component entries (appears in both SVG and panel contexts) |
| `.internal-component-header` | Header styling for internal component panels |
| `.internal-component-type-badge` | Badge styling for internal component type display |
| `.internal-component-host` | Host component info display in internal component panel |
| `.internal-component-description` | Description text styling for internal component details |
| `.internal-component-meta` | Metadata (installedAt, ID) display styling |
| `.internal-components-empty` | Empty state styling when no internal components exist |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/internal-components/registry` | Get all internal component type definitions with descriptions |
| GET | `/api/internal-components/:entityId/:hostComponentId` | Get internal components for a specific host component |
| GET | `/api/internal-components/:entityId` | Get all internal components for an entity |
| POST | `/api/internal-components/:entityId/:hostComponentId/add` | Add an internal component |
| DELETE | `/api/internal-components/:entityId/:hostComponentId/:internalComponentId` | Remove an internal component |

## Client-Side Integration

### ComponentViewer Internal Components

The `ComponentViewer` class provides a UI for viewing and expanding internal components:

1. Component cards with internal components show a 🔮 button
2. Clicking 🔮 toggles an expandable panel showing internal components
3. Internal components are displayed with their type, description, host info, and metadata
4. Primary data source: `entity.internalComponents` from the `show()` method's entity object
5. Fallback: API fetch from `/api/internal-components/${entityId}/${componentId}` when entity reference unavailable
6. Results cached in `this._internalComponentCache[componentId]` — cache is reset on every `show()` call
7. `_expandedInternalComponents` Map tracks expand/collapse state per component
8. `_internalComponentDescriptions` caches fetched registry descriptions

**Data Flow (Three-Tier Resolution):**
```
ComponentViewer.show() → _renderComponentGrid() → [🔮 button per component with internal comps]
  → User clicks 🔮 → _onToggleInternalComponents(componentId, component)
  → Tier 1: Check this._internalComponentCache[componentId] (cached result)
  → Tier 2: Use entity.internalComponents parameter from show() method
  → Tier 3: Fetch(`/api/internal-components/${entityId}/${componentId}`) as fallback
  → _renderInternalComponentPanel() → displays type badge, description, host info, meta
  → Toggle: clicking 🔮 again collapses the panel
```

**Registry Loading:**
```
ComponentViewer.show() → _loadInternalComponentRegistry() → fetch('/api/internal-components/registry')
  → Returns enhanced registry with human-readable descriptions
```

## smallBallDroid Auto-Installation

When a smallBallDroid entity spawns, the InternalComponentController automatically installs durabilityRepairSpheres on all non-finger components:

| Component | Identifier | Host Volume | Sphere Volume | Installed? |
|-----------|-----------|-------------|---------------|------------|
| centralBall | default | 10 | 2 | ✅ Yes |
| droidHead | default | 8 | 2 | ✅ Yes |
| droidArm | left | 8 | 2 | ✅ Yes |
| droidArm | right | 8 | 2 | ✅ Yes |
| droidRollingBall | left | 12 | 2 | ✅ Yes |
| droidRollingBall | right | 12 | 2 | ✅ Yes |
| droidHand | left_left | 6 | 2 | ✅ Yes |
| droidHand | right_left | 6 | 2 | ✅ Yes |
| humanoidDroidFinger | * | 4 | 2 | ❌ No (excluded) |

## Files

| File | Description |
|------|-------------|
| `data/internalComponents.json` | Internal component type definitions |
| `data/components.json` | Component definitions with volume property |
| `src/controllers/core/InternalComponentController.js` | Server-side controller |
| `src/controllers/core/stateEntityController.js` | Auto-install integration |
| `src/controllers/WorldStateController.js` | DI + API |
| `src/routes/internalComponentRoutes.js` | REST API |
| `public/js/UIManager.js` | UI integration |
| `public/js/Config.js` | Internal component colors/sizes |
| `public/css/internal-components.css` | Styles and animations |