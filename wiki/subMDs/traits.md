# 🧬 Traits System (Default-Override Architecture)

## 1. Overview
The Traits System is a data-driven approach to component attributes. Instead of defining every statistic for every component, the system uses a **Default-Override** pattern. Properties are defined globally, and components only specify values that deviate from the global default.

## 2. Architecture

### 2.1. Global Traits (Source of Truth)
The `Global_Traits` object defines the "mold" for various trait categories. 
- **Role**: Base Definition.
- **Location**: `src/controllers/traitsController.js`.
- **Example**:
  ```json
  {
    "Physical": {
      "durability": 100,
      "mass": 10,
      "volume": 1,
      "temperature": 20
    }
  }
  ```

### 2.2. Component Blueprints (Overrides)
Component blueprints specify which Traits they possess and the values they override.
- **Role**: Customization.
- **Location**: `src/controllers/componentController.js` (Component Registry).
- **Example**:
  ```json
  "droidArm": {
    "traits": {
      "Physical": { "durability": 50 }
    }
  }
  ```
  *In this case, `mass`, `volume`, and `temperature` are inherited from the Global Physical trait.*

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
