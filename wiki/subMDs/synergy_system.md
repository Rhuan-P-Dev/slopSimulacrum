# Synergy System

## Overview

The Synergy System computes combined effect multipliers when multiple components or entities collaborate on a single action. It plugs into the existing action execution pipeline, modifying the final outcome ("X") based on component compositions and multi-entity collaborations.

## What is "X"?

"X" is the **effective output value** of an action consequence — e.g., the actual damage dealt, the actual movement speed, or the actual healing amount. The synergy system modifies these values before consequences are applied.

## Architecture

```mermaid
graph TD
    Client --> Server
    Server --> WorldStateController
    WorldStateController --> ActionController
    WorldStateController --> SynergyController
    
    ActionController --> SynergyController
    ActionController --> ConsequenceHandlers
    
    SynergyController --> ComponentController
    SynergyController -.->|reads stats| StateEntityController
    
    SynergyController --> SynergyScaling
```

### Data Loading Flow

```mermaid
graph LR
    WSC[WorldStateController] -->|load| ActionsJSON[data/actions.json]
    WSC -->|load| SynergyJSON[data/synergy.json]
    WSC -->|inject| SynergyController
    SynergyController -->|uses| SynergyJSON
    WSC -->|inject| ActionController
    ActionController -->|uses| SynergyController
```

**Key Change**: Synergy configurations are **decoupled** from action definitions and loaded from a standalone `data/synergy.json` file. This follows the Single Responsibility Principle — actions define *what they do*, synergy defines *how components/entities collaborate*.

## Components

### 1. SynergyController (`src/controllers/synergyController.js`)

The main controller that computes synergy multipliers for actions.

**Constructor Signature:**
```javascript
constructor(worldStateController, actionRegistry, synergyRegistry, actionSelectController)
```

- `worldStateController`: Root state controller (injected)
- `actionRegistry`: Full action registry from `data/actions.json`
- `synergyRegistry`: Synergy registry from `data/synergy.json` (optional — auto-loaded if not provided)
- `actionSelectController`: Component selection controller (for locked-component exclusion)

**Key Responsibilities:**
- Compute single-entity component group synergy
- Compute multi-entity collaboration synergy
- Compute client-provided component synergy (multi-component selection)
- Apply caps to computed multipliers
- Build human-readable summaries

**Public API:**

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `computeSynergy()` | `actionName, entityId, context` | `SynergyResult` | Main entry — computes synergy for an action |
| `computeMultiEntitySynergy()` | `actionName, groupDef, config` | `{multiplier, components}` | Multi-entity collaboration |
| `applySynergyToResult()` | `synergyResult, baseValue` | `number` | Caps and applies multiplier |
| `getSynergySummary()` | `synergyResult` | `string` | Human-readable summary |
| `getSynergyConfig()` | `actionName` | `SynergyConfig` | Get synergy config for an action |
| `getActionsWithSynergy()` | — | `string[]` | All actions with synergy enabled |
| `clearCache()` | — | — | Clear the synergy cache |

**Private Methods (New):**

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `_evaluateProvidedComponents()` | `actionName, entityId, providedComponentIds, config` | `{multiplier, components}` | Evaluate synergy from client-provided component list |
| `_filterProvidedComponentsForGroup()` | `actionName, entityId, providedComponentIds, groupDef` | `Array` | Filter provided components for a group |
| `_matchesRoleFilter()` | `stats, roleFilter, component` | `boolean` | Check if component matches role filter |

### 2. SynergyScaling (`src/utils/SynergyScaling.js`)

Provides three scaling curve functions:

| Curve | Formula | Use Case |
|-------|---------|----------|
| `linear` | `base + bonus * (count - 1)` | Simple additive bonus |
| `diminishingReturns` | `base + bonus * (1 - e^(-2*(count-1)))` | Saturation curves (e.g., shooting) |
| `increasingReturns` | `base + bonus * (count-1)^1.5` | Accelerating curves (e.g., combos) |

## Data Model

### Standalone Synergy Definition (`data/synergy.json`)

Synergy configs are in a separate file from actions:

```json
{
  "actionName": {
    "enabled": true,
    "multiEntity": false,
    "scaling": "linear",
    "caps": {
      "effectKey": { "max": 1.25, "req": "trait.stat" }
    },
    "componentGroups": [
      {
        "groupType": "sameComponentType",
        "minCount": 2,
        "scaling": "diminishingReturns",
        "baseMultiplier": 1.0,
        "perUnitBonus": 0.05
      }
    ]
  }
}
```

### SynergyResult Object

```javascript
{
  actionName: string,           // The action this synergy applies to
  baseValue: number,            // Original consequence value
  synergyMultiplier: number,    // Computed multiplier (> 1.0 = bonus)
  finalValue: number,           // After caps
  capped: boolean,              // Whether the value was capped
  capKey: string | null,        // Which cap was applied
  contributingComponents: [     // List of contributors
    { componentId, entityId, componentType, contribution, role? }
  ],
  summary: string               // "Synergy: 1.35x, 2 entities, 3 components"
}
```

### SynergyPreview Object (New)

Sent in the server response for frontend display:

```javascript
{
  multiplier: number,           // Computed synergy multiplier
  finalValue: number,           // After caps
  capped: boolean,              // Whether capped
  capKey: string | null,        // Which cap was applied
  contributingComponents: [     // Simplified contributor list
    { componentId, entityId, componentType, contribution }
  ],
  summary: string               // Human-readable summary
}
```

## Group Types

| Type | Description | Example |
|------|-------------|---------|
| `sameComponentType` | Same component type on entity | 2x droidRollingBall |
| `movementComponents` | All components with Movement trait | droidRollingBall + any move component |
| `anyPhysical` | All components with Physical trait | droidHand + droidArm |
| `anyComponent` | All components on entity | Everything |

## Synergy Evaluation Modes

### Mode 1: Auto-Gather (Legacy)

When `computeSynergy()` is called **without** `providedComponentIds`, it uses the existing auto-gather logic:

1. `_evaluateComponentGroups()` iterates through `config.componentGroups`
2. `_gatherGroupMembers()` gathers members from the entity
3. `_gather*` methods exclude locked components via `ActionSelectController.getLockedComponentIds()`
4. Synergy multiplier calculated from gathered members

**Use Case**: Actions where the server auto-determines contributing components.

### Mode 2: Provided-Components (New)

When `computeSynergy()` is called **with** `providedComponentIds`, it uses the new `_evaluateProvidedComponents()` method:

```javascript
computeSynergy(actionName, entityId, {
    providedComponentIds: [
        { componentId: "uuid1", role: "source" },
        { componentId: "uuid2", role: "source" }
    ]
});
```

**Flow:**
1. `_evaluateProvidedComponents()` iterates through `config.componentGroups`
2. `_filterProvidedComponentsForGroup()` filters the provided list for each group
3. `_matchesRoleFilter()` checks if component stats match the role filter
4. Synergy multiplier calculated from matching members
5. Caps applied
6. Result returned to `ActionController`

**Use Case**: Multi-component selection where the user explicitly chooses which components contribute.

### Mode 3: Multi-Entity Collaboration

Multiple entities can collaborate on a single action. The client sends synergy groups with primary and supporting entities:

```json
{
  "actionName": "dash",
  "entityId": "entity-1",
  "params": {
    "synergyGroups": [
      {
        "primaryEntityId": "entity-1",
        "primaryComponentId": "droidRollingBall-1",
        "supportingEntityIds": ["entity-2"],
        "supportingComponentIds": ["droidRollingBall-2"],
        "perUnitBonus": 0.5
      }
    ]
  }
}
```

## Integration Flow

```mermaid
sequenceDiagram
    participant C as Client
    participant S as Server
    participant A as ActionController
    participant SC as SynergyController
    participant H as ConsequenceHandlers

    C->>S: POST /execute-action
    Note over C,S: With componentIds OR synergyGroups
    S->>A: executeAction()
    A->>SC: computeSynergy(actionName, entityId, context)
    
    alt providedComponentIds present
        SC->>SC: _evaluateProvidedComponents()
        SC->>SC: _filterProvidedComponentsForGroup()
    else auto-gather mode
        SC->>SC: _evaluateComponentGroups()
        SC->>SC: _gatherGroupMembers()
    end
    
    alt multiEntity enabled
        SC->>SC: _evaluateMultiEntityGroup()
    end
    
    SC->>SC: Apply caps
    SC-->>A: SynergyResult
    A->>H: _executeConsequences (with synergyResult)
    H->>H: Apply synergy multiplier to values
    H-->>A: results
    A-->>S: { synergy, results }
    S->>S: Build synergyPreview
    S-->>C: response + synergyPreview
    C->>UI: renderSynergyResult()
```

## Server Response Format

### ActionController Integration

```javascript
// In ActionController.executeAction():
const synergyResult = this.synergyController.computeSynergy(
  actionName, entityId, {
    providedComponentIds: componentList,     // NEW: client-provided
    synergyGroups: params?.synergyGroups,    // Legacy: multi-entity
    sourceComponentId: resolvedSourceComponentId
  }
);
```

### Server Response Integration

The server (`server.js`) now includes `synergyPreview` in the execute-action response:

```javascript
const responseResult = { ...result };
if (result.success && result.synergy) {
    responseResult.synergyPreview = {
        multiplier: result.synergy.synergyMultiplier,
        finalValue: result.synergy.finalValue,
        capped: result.synergy.capped,
        capKey: result.synergy.capKey,
        contributingComponents: result.synergy.contributingComponents.map((c) => ({
            componentId: c.componentId,
            entityId: c.entityId,
            componentType: c.componentType,
            contribution: c.contribution
        })),
        summary: result.synergy.summary
    };
}
```

### Frontend Display

The `UIManager.renderSynergyResult()` method displays synergy feedback:

```
Synergy: 1.05x
• droidHand (left-hand-...)
• droidHand (right-hand-...)
```

The display auto-hides after 8 seconds.

## Server Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/synergy/actions` | GET | All actions with synergy enabled |
| `/synergy/config/:actionName` | GET | Synergy config for an action |
| `/synergy/preview` | POST | Preview synergy without executing |

## WorldStateController Integration

The WorldStateController instantiates SynergyController as part of the DI chain:

```javascript
// Step 5: Load synergy.json separately
const synergyRegistry = DataLoader.loadJsonSafe('data/synergy.json') || {};

// Step 5: Instantiate SynergyController with separate synergy registry
const synergyController = new SynergyController(
    this, actionRegistry, synergyRegistry, actionSelectController
);
this.synergyController = synergyController;

// Step 6: Inject into ActionController
const actionController = new ActionController(
    this, consequenceHandlers, actionRegistry,
    componentCapabilityController, synergyController, actionSelectController
);
```

## Coding Standards

- **SRP**: SynergyController only computes multipliers, never executes consequences
- **Loose Coupling**: Reads via public APIs (ComponentController, StateEntityController)
- **No Magic Numbers**: All thresholds defined in SynergyScaling.js
- **Structured Logging**: Uses Logger utility with severity levels
- **Type Safety**: JSDoc annotations for all public methods
- **Data Decoupling**: Synergy configs are in `data/synergy.json`, not embedded in `data/actions.json`

## Related Documentation

- [Controller Patterns](controller_patterns.md) — Dependency Injection standards
- [Action System](action_system.md) — Action execution pipeline
- [Component Selection](component_selection.md) — Multi-component selection system
- [Code Quality](../code_quality_and_best_practices.md) — Engineering standards