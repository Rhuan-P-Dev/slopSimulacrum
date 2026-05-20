# Synergy System

## 1. Overview

Computes combined effect multipliers when multiple components of the same type collaborate. The synergy configuration defines scaling curves, caps, and group behavior for each action type.

## 2. Multiplier Curves

Three scaling curves are available:

| Curve | Behavior |
|-------|----------|
| `linear` | Multiplier grows proportionally with component count |
| `diminishingReturns` | Multiplier grows but at a decreasing rate |
| `increasingReturns` | Multiplier grows at an accelerating rate |

## 3. Synergy Application

The computed multiplier is applied to all numeric consequence properties, including movement distance, damage values, stat delta changes, and any future numeric parameters. The dispatcher iterates over resolved consequence parameters and applies the multiplier to each numeric value.

## 4. Evaluation Paths

Two evaluation paths exist depending on context:

| Path | When | Behavior |
|------|------|----------|
| Explicit component list | Client provides component IDs | Filters provided list for synergy groups |
| Auto-detection | No components specified | Auto-detects from the source component |

Both paths use same-component-type grouping with auto-detected component type.

## 5. Synergy Integration with Locks

Locked components are excluded from synergy pools. Components locked to the current action are allowed to participate.

## 6. Internal Component Synergy

Internal components do not directly participate in synergy calculations. Only host component stats are used. The repair system indirectly affects synergy by modifying component durability over time.

---

## Enhanced Synergy Preview System

### 1. Overview

Real-time synergy preview in the UI. Two display modes depending on the number of selected components:

| Mode | Components | Display |
|------|-----------|---------|
| **Action Data** | 1 | Action definition, resolved values, requirements |
| **Synergy** | 2+ | Multiplier, modified values, contributing components |

### 2. API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/synergy/preview-data` | POST | Full preview with action data, resolved values, and synergy |
| `/synergy/preview` | POST | Legacy: synergy result only |

### 3. Frontend Display

A UI manager method routes to either the action data HTML builder (1 component) or the synergy preview HTML builder (2+ components).

**CSS classes**: Preview panel (yellow border, persistent), result display (green border, auto-hide).

**Synergy-aware range**: Movement range indicators apply the synergy multiplier for accurate distance display.

### 4. Internal Component Impact

The preview reflects current stats at request time. The repair system may change durability between requests, affecting dash capability display. Internal component traits are not merged into host stats.