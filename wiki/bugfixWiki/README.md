# 🐛 Bugfix Wiki

Centralized knowledge base for all fixed bugs, known issues, and their resolutions in the `slopSimulacrum` project.

## How to Use

- Browse bugs by **severity** in the subdirectories (`critical/`, `high/`, `medium/`, `low/`, `architectural/`)
- Each bug has its own file with full details: symptoms, root cause, fix, and prevention
- Use the index table below for quick lookup

## Bug Index

### 🔴 Critical Severity

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-001](critical/BUG-001-multi-attacker-punch-target-role.md) | Multi-Attacker Punch: Target Components Treated as Attackers | ✅ Fixed | `b53e0dd` | `actionController.js` |
| [BUG-002](critical/BUG-002-malformed-consequence-error.md) | CRITICAL Error: Malformed Consequence Data Access | ✅ Fixed | `b53e0dd` | `actionController.js` |
| [BUG-003](critical/BUG-003-spatial-action-lock-leak.md) | Spatial Action Component Lock Leak | ✅ Fixed | `2573bea` | `actionController.js` |

### 🟠 High Severity

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-004](high/BUG-004-role-mismatch-skip.md) | Role Mismatch: Client/Server Resolution Difference | ✅ Fixed | `2573bea` | `actionController.js` |
| [BUG-005](high/BUG-005-deep-trait-merge.md) | Deep Trait-Level Merge: Stat Overwrite | ✅ Fixed | — | `componentStatsController.js` |
| [BUG-006](high/BUG-006-schema-validation-gap.md) | Schema Validation Gap for LLM Responses | ✅ Documented | — | `LLMController.js` |
| [BUG-007](high/BUG-007-graceful-degradation.md) | System Crashes from Non-Essential Module Errors | ✅ Documented | — | Architecture |
| [BUG-008](high/BUG-008-state-desync.md) | State Desynchronization Between Save/Load | ✅ Documented | — | `WorldStateController.js` |
| [BUG-009](high/BUG-009-server-direct-access.md) | Server Direct Sub-Controller Access | ✅ Fixed | — | `server.js`, `WorldStateController.js` |
| [BUG-010](high/BUG-010-self-target-resolution.md) | Self-Targeting Action Component Resolution | ✅ Fixed | `53fa440` | `actionController.js` |
| [BUG-021](high/BUG-021-spatial-action-race-condition.md) | Multi-Component Spatial Action Race Condition | ✅ Fixed | `22bf5dc` | `App.js` |
| [BUG-026](high/BUG-026-blueprint-expansion-sibling-skipped.md) | Blueprint Expansion: Sibling Components Skipped | ✅ Fixed | `41014fb3` | `entityController.js` |
| [BUG-028](high/BUG-028-socket-error-orphaned-mapping.md) | Socket Error Causes Orphaned Entity Mapping | ✅ Fixed | `pending` | `server.js` |
| [BUG-031](high/BUG-031-action-executor-direct-property-access.md) | ActionExecutor Direct Internal Property Access | ✅ Fixed | `pending` | `ActionExecutor.js`, `ActionManager.js` |
| [BUG-034](high/BUG-034-data-loader-silent-swallow.md) | DataLoader.loadJsonSafe Silently Swallows Errors | ✅ Fixed | `pending` | `DataLoader.js` |
| [BUG-035](high/BUG-035-state-entity-get-all-direct-reference.md) | stateEntityController.getAll() Returns Direct Reference | ✅ Fixed | `pending` | `stateEntityController.js` |
| [BUG-037](high/BUG-037-css-root-duplication.md) | CSS :root Variables Duplicated Across 10 Files | ✅ Fixed (partial) | `pending` | `public/css/*.css` |
| [BUG-040](high/BUG-040-equipment-registry-memory-leak.md) | Equipment Registry Memory Leak on Entity Despawn | ✅ Fixed | `pending` | `equipmentController.js`, `stateEntityController.js`, `WorldStateController.js` |
| [BUG-045](high/BUG-045-synergy-excludes-components-locked-to-current-action.md) | Synergy Excludes Components Locked to Current Action | ✅ Fixed | `pending` | `SynergyComponentGatherer.js`, `actionSelectController.js` |
| [BUG-046](high/BUG-046-filterProvidedForGroup-missing-filters.md) | _filterProvidedForGroup missing componentType/groupType filters | ✅ Fixed | `pending` | `synergyController.js` |
| [BUG-047](high/BUG-047-evaluateProvidedComponents-empty-contributing.md) | _evaluateProvidedComponents doesn't populate contributingComponents | ✅ Fixed | `pending` | `synergyController.js` |
| [BUG-050](high/BUG-050-consequences-missing-explicit-target-field.md) | Consequences Missing Explicit Target Field | ✅ Fixed | `pending` | `ConsequenceDispatcher.js`, `data/actions.json`, 6 handler modules |

### 🟡 Medium Severity

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-011](medium/BUG-011-srp-violation.md) | ActionController SRP Violation | ✅ Refactored | — | `actionController.js`, `componentCapabilityController.js` |
| [BUG-012](medium/BUG-012-removal-marker-null.md) | Removal Marker Sent as `null` Instead of Structured Object | ✅ Fixed | — | `componentCapabilityController.js` |
| [BUG-013](medium/BUG-013-selection-persistence.md) | Component Selection Lost on Page Refresh | ✅ Fixed | `2573bea` | `App.js`, `actionController.js` |
| [BUG-014](medium/BUG-014-defensive-copying.md) | Entity State Direct Mutation | ✅ Fixed | `d2e8c0b` | `entityController.js` |
| [BUG-015](medium/BUG-015-division-by-zero-scoring.md) | Division by Zero in Action Scoring (minValue = 0) | ⚠️ Known | — | `ActionScoring.js` |
| [BUG-019](medium/BUG-019-action-preview-name-missing.md) | Action Preview Name Missing (`_name` property) | ✅ Fixed | `22bf5dc` | `actionController.js`, `UIManager.js` |
| [BUG-020](medium/BUG-020-deltaspatial-speed-rendering.md) | deltaSpatial Speed Property Rendering | ✅ Fixed | `22bf5dc` | `UIManager.js` |
| [BUG-022](medium/BUG-022-duplicate-contributing-components.md) | Duplicate Contributing Components in Synergy Result | ✅ Fixed | `22bf5dc` | `synergyController.js` |
| [BUG-023](medium/BUG-023-range-indicator-ignores-synergy.md) | Range Indicator Ignores Synergy Multiplier | ✅ Fixed | `22bf5dc` | `App.js` |
| [BUG-024](medium/BUG-024-blueprint-recursion-stackoverflow.md) | Blueprint Recursion: Leaf-Only Blueprints Stack Overflow | ✅ Fixed | `41014fb3` | `entityController.js` |
| [BUG-027](medium/BUG-027-server-console-log-instead-of-logger.md) | Server Uses console.log Instead of Centralized Logger | ✅ Fixed | `4cf43abf` | `server.js` |
| [BUG-032](medium/BUG-032-controller-direct-property-access.md) | Controllers Directly Access Sub-Controller Private Properties | ✅ Fixed | `pending` | `actionController.js`, `WorldStateController.js` |
| [BUG-033](medium/BUG-033-synergy-cache-never-expires.md) | Synergy Cache Never Expires | ✅ Fixed | `pending` | `synergyController.js` |
| [BUG-036](medium/BUG-036-hardcoded-business-logic-in-action-controller.md) | Hardcoded Business Logic in ActionController | ⚠️ Known | — | `actionController.js` |
| [BUG-038](medium/BUG-038-hardcoded-colors-in-css.md) | Hardcoded Color Values in CSS | ⚠️ Known | — | `public/css/*.css` |
| [BUG-041](medium/BUG-041-equipmentController-srp-violation.md) | EquipmentController SRP Violation — Extracted 2 Modules | ✅ Fixed | `pending` | `equipmentController.js`, `HandEquipment.js`, `BackpackInventory.js` |
| [BUG-042](medium/BUG-042-synergyController-srp-violation.md) | SynergyController SRP Violation — Extracted 4 Modules | ✅ Fixed | `pending` | `synergyController.js`, `SynergyConfigManager.js`, `SynergyComponentGatherer.js`, `SynergyCalculator.js`, `SynergyCacheManager.js` |
| [BUG-043](medium/BUG-043-previewActionData-missing-resolvePlaceholders.md) | ActionController.previewActionData calls missing _resolvePlaceholders | ✅ Fixed | `pending` | `actionController.js` |
| [BUG-044](medium/BUG-044-actionSelectController-missing-getLockedComponentsForAction.md) | ActionSelectController missing getLockedComponentsForAction method | ✅ Fixed | `pending` | `actionSelectController.js`, `SynergyComponentGatherer.js` |
| [BUG-048](medium/BUG-048-dash-1-component-moves-4x.md) | Dash with 1 Component Moves 4x and Falsely Triggers 2-Component Synergy | ✅ Fixed | `pending` | `SynergyComponentGatherer.js`, `synergyController.js`, `synergy.json` |
| [BUG-049](medium/BUG-049-consequenceHandlers-srp-violation.md) | ConsequenceHandlers SRP Violation — Monolithic Handler Class | ✅ Fixed | `pending` | `consequenceHandlers.js`, 6 new focused modules |

### 🟢 Low Severity

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-016](low/BUG-016-ui-selection-state.md) | UI Actions Incorrectly Marked as Selected | ✅ Fixed | `bf19079` | `App.js` |
| [BUG-025](low/BUG-025-startroomid-scope-bug.md) | `startRoomId` Scope Bug in `_spawnKnifeInStartRoom()` | ✅ Fixed | `41014fb3` | `WorldStateController.js` |

### 🏗️ Architectural Fixes

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-017](architectural/BUG-017-dual-state-bug.md) | Dual State Bug: Internal Controller Instantiation | ✅ Fixed | — | All controllers |
| [BUG-018](architectural/BUG-018-actions-not-generic.md) | Hardcoded Actions (Not Data-Driven) | ✅ Fixed | `462ecc5`, `be6858d` | `actions.json`, `actionController.js` |
| [BUG-029](architectural/BUG-029-server-monolith-srp-violation.md) | Server Monolith Violates SRP | ✅ Fixed | `pending` | `src/server.js` |
| [BUG-030](architectural/BUG-030-css-monolith-srp-violation.md) | CSS Monolith Violates SRP | ✅ Fixed | `pending` | `public/styles.css`, `public/css/` |
| [BUG-051](architectural/BUG-051-provided-components-missing-type-filter.md) | _filterProvidedForGroup Missing Type Filter After groupType Unification | ⚠️ Known | `pending` | `synergyController.js` |

---

## Contributing New Bug Reports

See [template.md](template.md) for severity definitions, the bug report template, and step-by-step instructions for adding new bug reports.