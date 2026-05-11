# BUG-053: Client UI Layout SRP Violation — Monolithic Two-Column Layout

- **Severity**: HIGH
- **Status**: ✅ Fixed
- **Fixed In**: `pending`
- **Related Files**: `public/index.html`, `public/css/layout.css`, `public/js/App.js`, `public/js/UIManager.js`

## Symptoms

The client UI used a monolithic two-column grid layout with no clear separation of concerns:
- Map, navigation, and action registry were all mixed in a single layout
- No way to configure which UI elements were visible
- No support for customizable stat visualization
- Right panel was fixed and could not be hidden or moved

## Root Cause

The original layout was designed as a simple two-column grid (`.main-layout { grid-template-columns: 1fr 350px }`) that tightly coupled the map section with the control panel. This violated the Single Responsibility Principle by:
1. Mixing spatial visualization with action management in one static layout
2. Making it impossible to add new UI sections without major refactoring
3. No clear separation between config, view, and data panels

## Fix

Refactored the client UI into a **three-section vertical layout** with clear separation:

### New Layout Structure
```
┌──────────────────────────────────────────────────────────┐
│  🤖 SlopSimulacrum Terminal                              │
├──────────────────────────────────────────────────────────┤
│  TOP: ⚙️ Config Bar (50px, sticky)                      │
│  [🗿️ Components] [👍 Nav/Actions] [➕ Add Stat] [🎨]    │
├──────────────────────────────────────────────────────────┤
│  MIDDLE: 🛰️ Spatial Map (flex-grow: 1)                  │
│  [SVG Map fills available space]                         │
├──────────────────────────────────────────────────────────┤
│  BOTTOM: 📊 Stat Bars Panel (150px, scrollable)         │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Physical.mass      [████████░░] 80%  [✏️][🗑️]       │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### New Modules Created
| Module | Responsibility |
|--------|---------------|
| `ConfigBarManager.js` | Top config bar, panel coordination |
| `ComponentViewer.js` | 🗿️ Component detail overlay panel |
| `NavActionsPanel.js` | 👍 Navigation & actions floating panel |
| `StatBarsManager.js` | Configurable stat bar visualization |

### CSS Changes
- `base.css`: Added new CSS variables for config bar, overlays, stat bars, and trait colors
- `layout.css`: Replaced `.main-layout` grid with flexbox column layout
- `components.css`: Added styles for config buttons, overlays, stat bars, component viewer, dialogs

### New DOM Elements
- `#config-bar`: Top horizontal config bar
- `#map-section`: Middle section for SVG map
- `#stat-bars-section`: Bottom section for stat bars
- `#component-viewer-overlay`: Floating component viewer panel
- `#nav-actions-overlay`: Floating navigation & actions panel
- `#add-stat-dialog`: Centered modal for adding new stat bars

## Prevention
- Use modular managers for each UI section
- Keep DOM elements separated by section
- Define CSS variables for all colors and sizes
- Document layout architecture in wiki

## References
- Related wiki: `wiki/subMDs/client_ui.md`
- Related controller: `ClientApp`