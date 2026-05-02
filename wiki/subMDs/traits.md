# 🧬 Traits System (Default-Override Architecture)

## 1. Overview
The Traits System is a data-driven approach to component attributes. Instead of defining every statistic for every component, the system uses a **Default-Override** pattern. Properties are defined globally, and components only specify values that deviate from the global default.

## 2. Architecture

### 2.1. Global Traits (Source of Truth)
The `Global_Traits` object defines the "mold" for various trait categories. 
- **Role**: Base Definition.
- **Location**: Defined in `data/traits.json` and injected into `src/controllers/traitsController.js` via the Root Injector.
- **Example**:
  ```json
  {
    "Physical": {
      "durability": 100,
      "mass": 10,
      "volume": 1,
      "temperature": 20,
      "strength": 10
    },
    "Spatial": {
      "x": 0,
      "y": 0,
      "position": "0,0"
    }
  }
  ```

### 2.2. Component Blueprints (Overrides)
Component blueprints specify which Traits they possess and the values they override.
- **Role**: Customization.
- **Location**: `src/controllers/componentController.js` (Component Registry).

#### 2.2.1. Standard Traits Example
```json
"droidArm": {
  "traits": {
    "Physical": { "durability": 50 }
  }
}
```
*In this case, `mass`, `volume`, and `temperature` are inherited from the Global Physical trait.*

#### 2.2.2. Spatial Trait Example
Components can also have a `Spatial` trait to define their position relative to their parent entity:
```json
"droidArm": {
  "traits": {
    "Physical": { "durability": 50 },
    "Spatial": { "x": 20, "y": 10 }
  }
}
```
- `x`: Horizontal offset from entity center (positive = right, negative = left)
- `y`: Vertical offset from entity center (positive = down, negative = up)
- Position is calculated as: `screenX = entity.screenX + component.spatial.x`
- Position is calculated as: `screenY = entity.screenY + component.spatial.y`

### 2.3. The Merge Process (Instantiation)
When a component is instantiated, the system performs a merge to create the final stat object:
**`Final Value = Component Override || Global Default Value`**

The resulting object is cached in the `ComponentStatsController` to ensure high performance during runtime.

## 3. Logic and Priority

### 3.1. Value Resolution Hierarchy
When querying a stat, the system follows this priority (highest to lowest):
1. **Active Modifiers**: Temporary buffs, debuffs, or effects (Runtime).
2. **Component Override**: The value defined in the specific component blueprint.
3. **Global Trait**: The default value defined in `Global_Traits`.

### 3.2. Dynamic Injection
The system supports `addGlobalProperty(trait_id, property_key, default_value)`. Adding a property to the `Global_Traits` automatically makes it available to all components using that trait, enabling global system updates without modifying every blueprint.

## 4. Performance and Caching
- **Cache on Creation**: The merge process happens once during `initializeComponent`.
- **Invalidation**: The cache is only recalculated if the `Global_Traits` are modified or the component's blueprint changes.

## 5. Component Stats Persistence

The system performs a **deep trait-level merge** when updating component stats at runtime (e.g., via `updateComponentStatDelta` consequences). This ensures that updating a single stat does not erase other stats within the same trait category.

**Example:**
```
Before update:
  Physical: { durability: 120, mass: 10, volume: 1, temperature: 20, strength: 10 }

Dash action calls: setStats(componentId, { Physical: { durability: 115 } })

After update:
  Physical: { durability: 115, mass: 10, volume: 1, temperature: 20, strength: 10 }
  ← mass, volume, temperature, strength are PRESERVED
```

**Reference:** `src/controllers/componentStatsController.js` — `setStats()` method.

🐛 For fix details on the deep trait-level merge implementation, see [BUG-005](../../bugfixWiki/high/BUG-005-deep-trait-merge.md).