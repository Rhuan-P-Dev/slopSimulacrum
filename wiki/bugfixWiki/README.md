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
| [BUG-118](high/BUG-118-entity-spawns-at-room-center-instead-of-door.md) | Entity Spawns at Room Center Instead of Door Position on World Map Navigation | ✅ Fixed | `pending` | `RoomConnectionRenderer.js` |
| [BUG-114](high/BUG-114-dash-durability-loss-targets-wrong-component.md) | Dash Durability Loss Targets Wrong Component (Left Ball Affected When Dashing Right) | ✅ Fixed | `pending` | `ConsequenceDispatcher.js`, `actionController.js` |
| [BUG-093](high/BUG-093-equipped-item-stats-ignored-in-requirement-checks.md) | Equipped Item Stats Ignored in Action Requirement Checks | ✅ Fixed | `pending` | `RequirementResolver.js` |
| [BUG-094](high/BUG-094-cut-action-disappears-after-unequip-reequip.md) | Cut Action Disappears After Unequip/Re-equip (Sharpness Resets) | ✅ Fixed | `pending` | `HoldingCostController.js` |
| [BUG-099](high/BUG-099-cut-action-damage-ignores-sharpness-drain.md) | Knife Cut Damage Always Uses Base Sharpness (50), Ignoring Sharpness Drain | ✅ Fixed | `pending` | `RequirementResolver.js`, `ActionController.js`, `WorldStateController.js` |
| [BUG-102](high/BUG-102-dead-actionmanager-drop-action-methods.md) | Dead ActionManager Drop Action Methods (getPendingDropAction, setPendingDropAction, clearPendingDropAction) | ✅ Fixed | `pending` | `ActionManager.js`, `ActionExecutor.js`, `App.js` |
| [BUG-109](high/BUG-109-knife-not-selected-for-cut-action.md) | Knife Not Selected When Clicked in ⚔️ Actions Panel for "cut" Action | ✅ Fixed | `pending` | `NavActionsPanel.js`, `App.js` |
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
| [BUG-045](high/BUG-045-synergy-excludes-components-locked-to-current-action.md) | Synergy Excludes Components Locked to Current Action | ✅ Fixed | `pending` | `SynergyComponentGatherer.js`, `actionSelectController.js` |
| [BUG-046](high/BUG-046-filterProvidedForGroup-missing-filters.md) | _filterProvidedForGroup missing componentType/groupType filters | ✅ Fixed | `pending` | `synergyController.js` |
| [BUG-047](high/BUG-047-evaluateProvidedComponents-empty-contributing.md) | _evaluateProvidedComponents doesn't populate contributingComponents | ✅ Fixed | `pending` | `synergyController.js` |
| [BUG-050](high/BUG-050-consequences-missing-explicit-target-field.md) | Consequences Missing Explicit Target Field | ✅ Fixed | `pending` | `ConsequenceDispatcher.js`, `data/actions.json`, 6 handler modules |
| [BUG-064](high/BUG-064-nav-actions-panel-signature-mismatch.md) | NavActionsPanel "function is not iterable" error after navigation refactor | ✅ Fixed | `pending` | `App.js`, `NavActionsPanel.js` |
| [BUG-065](high/BUG-065-world-map-connection-arrows-wrong-direction.md) | World Map Connection Arrows Drawn with Wrong Direction (Center-to-Center) | ✅ Fixed | `pending` | `WorldMapView.js`, `RoomConnectionRenderer.js` |
| [BUG-066](high/BUG-066-map-connections-not-clickable.md) | Map Connection Arrows Not Clickable (CSS pointer-events Blocks Interaction) | ✅ Fixed | `pending` | `navigation.css`, `WorldMapView.js`, `RoomConnectionRenderer.js`, `UIManager.js` |
| [BUG-069](high/BUG-069-server-missing-worldStateController-locals.md) | Server Missing `worldStateController` in Express `app.locals` | ✅ Fixed | `pending` | `internalComponentRoutes.js`, `routes/index.js` |
| [BUG-070](high/BUG-070-evaluateProvidedComponents-empty-contributing.md) | _evaluateProvidedComponents doesn't populate contributingComponents (duplicate BUG-047) | ✅ Fixed | `pending` | `synergyController.js` |
| [BUG-073](high/BUG-073-missing-inventory-system.md) | Missing Inventory System — Volume-Based Item Storage | ✅ Fixed | — | `InventoryManager.js`, `inventoryRoutes.js`, `inventory.css` |
| [BUG-074](high/BUG-074-test-item-not-broadcast-to-client.md) | Test Item Added to Server but Not Visible on Client (Broadcast Timing) | ✅ Fixed | `pending` | `WorldStateController.js`, `server.js` |
| [BUG-075](high/BUG-075-missing-holding-cost-system.md) | Missing Holding Cost System — Equipped Item Stat Debuffs | ✅ Fixed | — | `HoldingCostController.js`, `data/holdingCost.json` |
| [BUG-076](high/BUG-076-dropped-items-not-persisted.md) | Dropped Items Not Persisted Across Server Restarts | 🔴 Open | — | `WorldStateController.js`, `inventoryRoutes.js` |
| [BUG-078](high/BUG-078-overlay-panel-data-flow-regression.md) | Overlay Panel Data Flow Regression | ✅ Fixed | `pending` | `OverlayManager.js`, `App.js`, `ComponentViewer.js`, `NavActionsPanel.js` |
| [BUG-079](high/BUG-079-dropped-items-undefined-coordinates.md) | Dropped Items Appear at (undefined, undefined) — Invisible on Map | ✅ Fixed | `pending` | `data/actions.json` |
| [BUG-081](high/BUG-081-pickup-item-direct-consequence-handler-access.md) | `/pick-up-item` Route Directly Accesses Consequence Handler (Violates Public API Rule) | 🔴 Open | — | `worldRoutes.js` |
| [BUG-082](high/BUG-082-dropped-items-render-off-screen.md) | Dropped Items Render Off-Screen — SVG Coordinate Mismatch | ✅ Fixed | `pending` | `EventDispatcher.js` |
| [BUG-083](high/BUG-083-dropped-item-distance-check-coord-mismatch.md) | Drop Item Distance Check Fails — Droid Spatial vs SVG ViewBox Coordinate Mismatch | ✅ Fixed | `pending` | `ActionExecutor.js` |
| [BUG-084](high/BUG-084-dropitem-range-ignored-actions-json.md) | dropItem Range Expression in actions.json Ignored on Client | ✅ Fixed | `pending` | `ActionExecutor.js`, `App.js`, `data/actions.json` |
| [BUG-086](high/BUG-086-pickup-item-direct-consequence-handler-access-wrong-prop-name.md) | `/pick-up-item` Returns 500 — Wrong Property Name & Direct Handler Access | ✅ Fixed | `pending` | `WorldStateController.js`, `worldRoutes.js` |
| [BUG-087](high/BUG-087-component-getComponent-missing-from-worldstatecontroller.md) | `getComponent` Missing from WorldStateController — Pick-Up Calls Non-Existent Method | ✅ Fixed | `pending` | `WorldStateController.js`, `PickUpItemHandler.js` |
| [BUG-092](high/BUG-092-equipped-undefined-knife-malformed-component-id.md) | Equipped Item Component ID `equipped-undefined-knife` Causes Entity Not Found | ✅ Fixed | `pending` | `componentCapabilityController.js`, `HoldingCostController.js`, `actionController.js`, `actionSelectController.js`, `ComponentResolver.js` |
| [BUG-096](high/BUG-096-knife-sharpness-drain-not-working.md) | Knife Sharpness Drain (-999) Not Working — Equipped Items Lack In-Memory Stats | ✅ Fixed | `pending` | `EquippedItemStatsController.js`, `HoldingCostController.js`, `StatConsequenceHandler.js`, `WorldStateController.js` |
| [BUG-097](high/BUG-097-cut-action-disappears-after-use.md) | Cut Action Shows "0 capables · 1 incapable" After Use — Capability Cache Re-evaluation Missing Equipped Item Stats | ✅ Fixed | `pending` | `ComponentCapabilityController.js` |
| [BUG-110](high/BUG-110-knife-cut-action-no-damage-no-sharpness-drain.md) | Knife Cut Action — No Damage Dealt and No Sharpness Drain (eqId Lost in Consequence Pipeline) | ✅ Fixed | `pending` | `actionController.js`, `ConsequenceDispatcher.js`, `StatConsequenceHandler.js` |
| [BUG-111](high/BUG-111-equipment-id-not-resolved-in-selection-system.md) | Equipment ID (eq-*) Not Resolved in Component Selection System — Actions Fail When Using Equipped Items | ✅ Fixed | `pending` | `actionSelectController.js`, `selectionRoutes.js`, `actionController.js`, `WorldStateController.js` |
| [BUG-112](high/BUG-112-equipment-id-not-resolved-in-synergy-system.md) | Equipment ID (eq-*) Not Resolved in Synergy System — Synergy Multiplier Incorrect for Equipped Items | ✅ Fixed | `pending` | `synergyController.js`, `SynergyComponentGatherer.js` |
| [BUG-113](high/BUG-113-equipment-id-not-resolved-in-multi-attacker-consequence-dispatcher.md) | Equipment ID (eq-*) Not Resolved in Multi-Attacker Consequence Dispatcher — Equipped Item Attackers Skipped | ✅ Fixed | `pending` | `ConsequenceDispatcher.js` |
| [BUG-098](high/BUG-098-server-hangs-on-shutdown-with-connected-clients.md) | Server Hangs Indefinitely on Shutdown When Clients Are Connected | ✅ Fixed | `pending` | `server.js` |
| [BUG-100](high/BUG-100-drop-item-sends-svg-coordinates-instead-of-room-space.md) | Drop Item Sends SVG ViewBox Coordinates Instead of Room-Space | ✅ Fixed | `pending` | `EventDispatcher.js`, `ActionExecutor.js` |
| [BUG-101](high/BUG-101-server-range-validator-ignores-expression-strings.md) | Server RangeValidator Ignores Range Expression Strings | ✅ Fixed | `pending` | `RangeValidator.js`, `PlaceholderResolver.js` |
| [BUG-117](high/BUG-117-dropped-items-visible-across-all-rooms.md) | Dropped Items Visible Across All Rooms | ✅ Fixed | `pending` | `DropItemHandler.js`, `WorldStateController.js`, `PickUpItemHandler.js`, `App.js` |
| [BUG-120](high/BUG-120-isDescendantOf-infinite-loop-risk.md) | _isDescendantOf Potential Infinite Loop on Corrupted Data (Circular Reference) | ✅ Fixed | `pending` | `InventoryManager.js` |
| [BUG-122](high/BUG-122-executePickUpItem-direct-private-access.md) | executePickUpItem Direct Access to Private Controller Properties (Violates Public API Rule) | 🔴 Open | — | `WorldStateController.js` |
| [BUG-126](high/BUG-126-nested-items-vanish-on-drop-pickup.md) | Nested Items Vanish When Container is Dropped and Picked Up | ✅ Fixed | `pending` | `InventoryManager.js`, `DropItemHandler.js`, `PickUpItemHandler.js` |
| [BUG-129](high/BUG-129-client-side-inventory-uses-item-volume-instead-of-externalVolume-for-host-component-display.md) | Client-Side Inventory Uses item.volume Instead of externalVolume for Host Component Display | ✅ Fixed | `pending` | `InventoryManager.js` (client) |
| [BUG-131](high/BUG-131-universal-tick-system-delayed-first-execution.md) | UniversalTickSystem Jobs Delayed by One Interval on First Execution | ✅ Fixed | `pending` | `UniversalTickSystem.js` |
| [BUG-132](high/BUG-132-channel-damage-silently-never-applied.md) | Channel Damage Silently Never Applied (DAMAGE_CHANNELS Member Test on an Object) | ✅ Fixed | `pending` | `DamageConsequenceHandler.js` |
| [BUG-133](high/BUG-133-multi-attacker-punch-drops-channel-damage.md) | Multi-Attacker Punch Drops Channel Damage (Zero Damage Dealt) | ✅ Fixed | `pending` | `ConsequenceDispatcher.js` |
| [BUG-134](high/BUG-134-two-fist-punch-drops-no-chunks.md) | Two-Fist Punch Drops No Chunks (D11 No-Propagation Blocked Intended Per-Fist Drops) | ✅ Fixed | `pending` | `ConsequenceDispatcher.js`, `MaterialChunkDropHandler.js` |

### 🟡 Medium Severity

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-088](medium/BUG-088-cross-action-selection-not-updating.md) | Cross-Action Component Graying Not Updating in Real-Time | ✅ Fixed | `pending` | `App.js` |
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
| [BUG-042](medium/BUG-042-synergyController-srp-violation.md) | SynergyController SRP Violation — Extracted 4 Modules | ✅ Fixed | `pending` | `synergyController.js`, `SynergyConfigManager.js`, `SynergyComponentGatherer.js`, `SynergyCalculator.js`, `SynergyCacheManager.js` |
| [BUG-043](medium/BUG-043-previewActionData-missing-resolvePlaceholders.md) | ActionController.previewActionData calls missing _resolvePlaceholders | ✅ Fixed | `pending` | `actionController.js` |
| [BUG-044](medium/BUG-044-actionSelectController-missing-getLockedComponentsForAction.md) | ActionSelectController missing getLockedComponentsForAction method | ✅ Fixed | `pending` | `actionSelectController.js`, `SynergyComponentGatherer.js` |
| [BUG-048](medium/BUG-048-dash-1-component-moves-4x.md) | Dash with 1 Component Moves 4x and Falsely Triggers 2-Component Synergy | ✅ Fixed (Round 2) | `pending` | `SynergyComponentGatherer.js`, `synergyController.js`, `data/synergy.json` |
| [BUG-049](medium/BUG-049-consequenceHandlers-srp-violation.md) | ConsequenceHandlers SRP Violation — Monolithic Handler Class | ✅ Fixed | `pending` | `consequenceHandlers.js`, 6 new focused modules |
| [BUG-054](medium/BUG-054-ConfigBarManager-wrong-action-endpoint.md) | ConfigBarManager Calls Non-Existent Action Endpoint (`/api/world/actions/:id`) | ✅ Fixed | `pending` | `ConfigBarManager.js` |
| [BUG-055](medium/BUG-055-nav-actions-panel-listeners-not-attached.md) | NavActionsPanel Navigation Buttons Non-Functional (Listeners Never Attached) | ✅ Fixed | `pending` | `NavActionsPanel.js` |
| [BUG-056](medium/BUG-056-action-execution-callback-missing.md) | Action Execution Callback Missing from ConfigBarManager and App.js | ✅ Fixed | `pending` | `App.js`, `ConfigBarManager.js`, `NavActionsPanel.js` |
| [BUG-057](medium/BUG-057-nav-panel-missing-selection-ui.md) | NavActionsPanel Missing Multi-Component Selection UI and Room Update | ✅ Fixed | `pending` | `NavActionsPanel.js`, `App.js`, `ConfigBarManager.js`, `actions.css` |
| [BUG-058](medium/BUG-058-nav-panel-missing-grayed-component-click-handler.md) | NavActionsPanel Missing Grayed Component Click Handler | ✅ Fixed | `pending` | `NavActionsPanel.js`, `SelectionController.js`, `App.js`, `ConfigBarManager.js` |
| [BUG-059](medium/BUG-059-dash-range-indicator-ignores-selected-components.md) | Dash Range Indicator Ignores Selected Component Count | ✅ Fixed | `pending` | `SynergyPreviewController.js`, `App.js` |
| [BUG-060](medium/BUG-060-add-stat-not-component-related.md) | "➕ Add Stat" Dialog Not Related to Any Entity Component | ✅ Fixed | `pending` | `StatBarsManager.js`, `ComponentViewer.js`, `ConfigBarManager.js` |
| [BUG-061](medium/BUG-061-stat-bar-not-updating-after-add.md) | Stat Bar Shows 0% After Adding (updateAll() Not Called) | ✅ Fixed | `pending` | `StatBarsManager.js` |
| [BUG-062](medium/BUG-062-stat-bars-not-updating-after-component-change.md) | Stat Bars Don't Update When Component Stats Change | ✅ Fixed | `pending` | `server.js`, `WorldStateController.js`, `EventDispatcher.js`, `App.js` |
| [BUG-063](medium/BUG-063-hardcoded-room-definitions.md) | Hardcoded Room Definitions in RoomsController | ✅ Fixed | `3267ec8` | `RoomsController.js`, `data/rooms.json` |
| [BUG-067](medium/BUG-067-internal-components-system.md) | Internal Components System — durabilityRepairSphere | ✅ Implemented | `pending` | `InternalComponentController.js` |
| [BUG-068](medium/BUG-068-component-viewer-missing-internal-components.md) | Component Viewer Missing Internal Components Display | ✅ Fixed | `pending` | `ComponentViewer.js`, `internal-components.css`, `internalComponentRoutes.js` |
| [BUG-080](medium/BUG-080-drop-selector-executes-with-null-pending-item.md) | Drop Selector Execute: `pendingDropItem` Cleared Before Event Dispatch | ✅ Fixed | `pending` | `DropSelectorController.js` |
| [BUG-104](medium/BUG-104-unused-knife-component-in-components-json.md) | Unused `knife` Component Definition in data/components.json | ✅ Fixed | `pending` | `data/components.json` |
| [BUG-105](medium/BUG-105-css-duplicate-selectors-across-files.md) | CSS Duplicate Selectors Across Multiple Files | ✅ Fixed | `pending` | `layout.css`, `components.css`, `floating-windows.css` |
| [BUG-117](medium/BUG-117-world-map-arrow-overlap.md) | World Map Arrow Overlap — Bidirectional Connection Arrows and Text Labels Too Close Together | ✅ Fixed | `pending` | `RoomConnectionRenderer.js`, `WorldMapView.js` |
| [BUG-121](medium/BUG-121-components-json-repeated-loading.md) | components.json Repeatedly Loaded on Every Volume Check | ✅ Fixed | `pending` | `InventoryManager.js` |
| [BUG-123](medium/BUG-123-client-console-usage.md) | Client-Side InventoryManager Uses console.* Instead of Logger | 🔴 Open | — | `InventoryManager.js` (client) |
| [BUG-124](medium/BUG-124-checkItemFit-missing-container-volume.md) | _checkItemFit Does Not Account for Container Volume (Nested Inventory) | ✅ Fixed | `pending` | `InventoryManager.js` (client) |
| [BUG-125](medium/BUG-125-container-header-destroyed-by-toggle.md) | Container Header Destroyed by _toggleContainer() (Double Toggle) | ✅ Fixed | `pending` | `InventoryManager.js` |
| [BUG-130](medium/BUG-130-consequence-handler-actionParams-modifications-not-propagated.md) | Consequence Handler actionParams Modifications Not Propagated to Subsequent Consequences | ✅ Fixed | `t1-weapon-implementation` | `ConsequenceDispatcher.js` |

### 🟢 Low Severity

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-016](low/BUG-016-ui-selection-state.md) | UI Actions Incorrectly Marked as Selected | ✅ Fixed | `bf19079` | `App.js` |
| [BUG-025](low/BUG-025-startroomid-scope-bug.md) | `startRoomId` Scope Bug in `_spawnKnifeInStartRoom()` | ✅ Fixed | `41014fb3` | `WorldStateController.js` |
| [BUG-115](low/BUG-115-internal-components-panel-overflows-card.md) | Internal Components Panel Overflows Card Boundaries Horizontally | ✅ Fixed | `pending` | `internal-components.css`, `components.css`, `ComponentViewer.js` |
| [BUG-116](low/BUG-116-host-text-overflows-internal-component-card.md) | Host Component Type Text Overflows in Internal Component Cards | ✅ Fixed | `pending` | `internal-components.css`, `components.css`, `ComponentViewer.js` |

### 🏗️ Architectural Fixes

| ID | Title | Status | Fixed In | Related Files |
|----|-------|--------|----------|---------------|
| [BUG-017](architectural/BUG-017-dual-state-bug.md) | Dual State Bug: Internal Controller Instantiation | ✅ Fixed | — | All controllers |
| [BUG-018](architectural/BUG-018-actions-not-generic.md) | Hardcoded Actions (Not Data-Driven) | ✅ Fixed | `462ecc5`, `be6858d` | `actions.json`, `actionController.js` |
| [BUG-029](architectural/BUG-029-server-monolith-srp-violation.md) | Server Monolith Violates SRP | ✅ Fixed | `pending` | `src/server.js` |
| [BUG-030](architectural/BUG-030-css-monolith-srp-violation.md) | CSS Monolith Violates SRP | ✅ Fixed | `pending` | `public/styles.css`, `public/css/` |
| [BUG-051](architectural/BUG-051-provided-components-missing-type-filter.md) | _filterProvidedForGroup Missing Type Filter After groupType Unification | ✅ Fixed (Round 2) | `pending` | `synergyController.js`, `SynergyComponentGatherer.js` |
| [BUG-052](architectural/BUG-052-controllers-directory-structure-srp-violation.md) | Controllers Directory Structure SRP Violation — Organized into Subdirectories | ✅ Fixed | `pending` | `src/controllers/` (all 30 files) |
| [BUG-053](architectural/BUG-053-client-ui-layout-srp-violation.md) | Client UI Layout SRP Violation — Refactored to Three-Section Vertical Layout | ✅ Fixed | `pending` | `public/index.html`, `public/css/layout.css`, `public/js/App.js`, `public/js/UIManager.js` |
| [BUG-077](architectural/BUG-077-missing-overlay-manager.md) | Missing Overlay Manager — Floating Window Coordination | ✅ Fixed | `pending` | `OverlayManager.js`, `floating-windows.css`, `ConfigBarManager.js` |
| [BUG-089](architectural/BUG-089-hardcoded-punch-handler-in-frontend.md) | Hardcoded Punch Handler in Frontend — Not Generic for New Attack Types | ✅ Fixed | `pending` | `App.js`, `EventDispatcher.js`, `ActionExecutor.js` |
| [BUG-090](architectural/BUG-090-hardcoded-punch-method-names-in-frontend.md) | Hardcoded Punch Method Names in Frontend — Not Generic for New Attack Types | ✅ Fixed | `pending` | `ActionManager.js`, `ActionExecutor.js`, `actionController.js` |
| [BUG-103](architectural/BUG-103-dead-code-in-controllers.md) | Dead Code in Controllers — Multiple Files | ✅ Fixed | `pending` | `ComponentResolver.js`, `componentStatsController.js`, `DropItemHandler.js`, `actionSelectController.js` |
| [BUG-119](architectural/BUG-119-connection-format-mismatch.md) | Connection Storage Format Mismatch Between Branches Causing 10 Merge Conflicts | ✅ Fixed | `pending` | `RoomsController.js`, `RoomConnectionRenderer.js`, `App.js` |

---

## Contributing New Bug Reports

See [template.md](template.md) for severity definitions, the bug report template, and step-by-step instructions for adding new bug reports.