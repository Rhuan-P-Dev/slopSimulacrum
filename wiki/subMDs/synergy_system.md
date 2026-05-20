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