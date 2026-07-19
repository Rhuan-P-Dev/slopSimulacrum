# High Severity Bugs

Major feature impairments and incorrect behaviors that had workarounds available.

| Bug ID | Title | Status | Fixed In |
|--------|-------|--------|----------|
| [BUG-128](high/BUG-128-t1-weapon-placement-used-wrong-volume-metric.md) | T1 Weapon Placement Checked Max Volume Instead of Available Volume | ✅ Fixed | `t1-weapon-implementation` |
| [BUG-127](high/BUG-127-inventory-items-lack-dual-volume-model.md) | Inventory Items Lack Dual-Volume Model (externalVolume Not Supported) | ✅ Fixed | `t1-weapon-implementation` |
| [BUG-126](high/BUG-126-nested-items-vanish-on-drop-pickup.md) | Nested Items Vanish on Drop/Pickup | ✅ Fixed | — |
| [BUG-122](high/BUG-122-executePickUpItem-direct-private-access.md) | executePickUpItem Direct Private Access | ✅ Fixed | — |
| [BUG-120](high/BUG-120-isDescendantOf-infinite-loop-risk.md) | isDescendantOf Infinite Loop Risk | ✅ Fixed | — |
| [BUG-118](high/BUG-118-entity-spawns-at-room-center-instead-of-door.md) | Entity Spawns at Room Center Instead of Door | ✅ Fixed | — |
| [BUG-117](high/BUG-117-dropped-items-visible-across-all-rooms.md) | Dropped Items Visible Across All Rooms | ✅ Fixed | — |
| [BUG-114](high/BUG-114-dash-durability-loss-targets-wrong-component.md) | Dash Durability Loss Targets Wrong Component | ✅ Fixed | — |
| [BUG-113](high/BUG-113-equipment-id-not-resolved-in-multi-attacker-consequence-dispatcher.md) | Equipment ID Not Resolved in Multi-Attacker Consequence Dispatcher | ✅ Fixed | — |
| [BUG-112](high/BUG-112-equipment-id-not-resolved-in-synergy-system.md) | Equipment ID Not Resolved in Synergy System | ✅ Fixed | — |
| [BUG-111](high/BUG-111-worldstatemanager-getequippeditem-uses-wrong-prop-name.md) | WorldStateManager getEquippedItem Uses Wrong Prop Name | ✅ Fixed | — |
| [BUG-111](high/BUG-111-equipment-id-not-resolved-in-selection-system.md) | Equipment ID Not Resolved in Selection System | ✅ Fixed | — |
| [BUG-110](high/BUG-110-knife-cut-action-no-damage-no-sharpness-drain.md) | Knife Cut Action No Damage No Sharpness Drain | ✅ Fixed | — |
| [BUG-110](high/BUG-110-requirement-resolver-equipped-stats-replace-instead-of-merge.md) | Requirement Resolver Equipped Stats Replace Instead of Merge | ✅ Fixed | — |
| [BUG-109](high/BUG-109-equipped-item-stats-lookup-and-merge-issues.md) | Equipped Item Stats Lookup, Cut Action, and Strength Requirement Failures | ✅ Fixed | `typed-id-equipped-bugs-fix` |
| [BUG-109](high/BUG-109-knife-not-selected-for-cut-action.md) | Knife Not Selected for Cut Action | ✅ Fixed | — |
| [BUG-102](high/BUG-102-dead-actionmanager-drop-action-methods.md) | Dead ActionManager Drop Action Methods | ✅ Fixed | — |
| [BUG-101](high/BUG-101-server-range-validator-ignores-expression-strings.md) | Server Range Validator Ignores Expression Strings | ✅ Fixed | — |
| [BUG-100](high/BUG-100-constructor-ordering-bug.md) | Constructor Ordering Bug | ✅ Fixed | — |
| [BUG-100](high/BUG-100-drop-item-sends-svg-coordinates-instead-of-room-space.md) | Drop Item Sends SVG Coordinates Instead of Room Space | ✅ Fixed | — |
| [BUG-099](high/BUG-099-cut-action-damage-ignores-sharpness-drain.md) | Cut Action Damage Ignores Sharpness Drain | ✅ Fixed | — |
| [BUG-098](high/BUG-098-server-hangs-on-shutdown-with-connected-clients.md) | Server Hangs on Shutdown with Connected Clients | ✅ Fixed | — |
| [BUG-097](high/BUG-097-cut-action-disappears-after-use.md) | Cut Action Disappears After Use | ✅ Fixed | — |
| [BUG-096](high/BUG-096-knife-sharpness-drain-not-working.md) | Knife Sharpness Drain Not Working | ✅ Fixed | — |
| [BUG-095](high/BUG-095-punch-disappears-when-equipping-knife.md) | Punch Disappears When Equipping Knife | ✅ Fixed | — |
| [BUG-094](high/BUG-094-cut-action-disappears-after-unequip-reequip.md) | Cut Action Disappears After Unequip/Reequip | ✅ Fixed | — |
| [BUG-093](high/BUG-093-equipped-item-stats-ignored-in-requirement-checks.md) | Equipped Item Stats Ignored in Requirement Checks | ✅ Fixed | — |
| [BUG-092](high/BUG-092-equipped-undefined-knife-malformed-component-id.md) | Equipped Undefined Knife Malformed Component ID | ✅ Fixed | — |
| [BUG-091](high/BUG-091-drop-item-range-uses-wrong-action-definition.md) | Drop Item Range Uses Wrong Action Definition | ✅ Fixed | — |
| [BUG-087](high/BUG-087-component-getComponent-missing-from-worldstatecontroller.md) | Component getComponent Missing from WorldStateController | ✅ Fixed | — |
| [BUG-086](high/BUG-086-pickup-item-direct-consequence-handler-access-wrong-prop-name.md) | Pickup Item Direct Consequence Handler Access Wrong Prop Name | ✅ Fixed | — |
| [BUG-085](high/BUG-085-render-range-indicator-nan.md) | Render Range Indicator NaN | ✅ Fixed | — |
| [BUG-084](high/BUG-084-dropitem-range-ignored-actions-json.md) | Dropitem Range Ignored Actions.json | ✅ Fixed | — |
| [BUG-083](high/BUG-083-dropped-item-distance-check-coord-mismatch.md) | Dropped Item Distance Check Coord Mismatch | ✅ Fixed | — |
| [BUG-082](high/BUG-082-dropped-items-render-off-screen.md) | Dropped Items Render Off Screen | ✅ Fixed | — |
| [BUG-081](high/BUG-081-pickup-item-direct-consequence-handler-access.md) | Pickup Item Direct Consequence Handler Access | ✅ Fixed | — |
| [BUG-079](high/BUG-079-dropped-items-undefined-coordinates.md) | Dropped Items Undefined Coordinates | ✅ Fixed | — |
| [BUG-078](high/BUG-078-overlay-panel-data-flow-regression.md) | Overlay Panel Data Flow Regression | ✅ Fixed | — |
| [BUG-076](high/BUG-076-dropped-items-not-persisted.md) | Dropped Items Not Persisted | ✅ Fixed | — |
| [BUG-075](high/BUG-075-missing-holding-cost-system.md) | Missing Holding Cost System | ✅ Fixed | — |
| [BUG-074](high/BUG-074-test-item-not-broadcast-to-client.md) | Test Item Not Broadcast to Client | ✅ Fixed | — |
| [BUG-073](high/BUG-073-missing-inventory-system.md) | Missing Inventory System | ✅ Fixed | — |
| [BUG-070](high/BUG-070-evaluateProvidedComponents-empty-contributing.md) | evaluateProvidedComponents Empty Contributing | ✅ Fixed | — |
| [BUG-069](high/BUG-069-server-missing-worldStateController-locals.md) | Server Missing WorldStateController Locals | ✅ Fixed | — |
| [BUG-066](high/BUG-066-map-connections-not-clickable.md) | Map Connections Not Clickable | ✅ Fixed | — |
| [BUG-065](high/BUG-065-world-map-connection-arrows-wrong-direction.md) | World Map Connection Arrows Wrong Direction | ✅ Fixed | — |
| [BUG-064](high/BUG-064-nav-actions-panel-signature-mismatch.md) | Nav Actions Panel Signature Mismatch | ✅ Fixed | — |
| [BUG-050](high/BUG-050-consequences-missing-explicit-target-field.md) | Consequences Missing Explicit Target Field | ✅ Fixed | — |
| [BUG-046](high/BUG-046-filterProvidedForGroup-missing-filters.md) | filterProvidedForGroup Missing Filters | ✅ Fixed | — |
| [BUG-045](high/BUG-045-synergy-excludes-components-locked-to-current-action.md) | Synergy Excludes Components Locked to Current Action | ✅ Fixed | — |
| [BUG-037](high/BUG-037-css-root-duplication.md) | CSS Root Duplication | ✅ Fixed | — |
| [BUG-035](high/BUG-035-state-entity-get-all-direct-reference.md) | State Entity getAll Direct Reference | ✅ Fixed | — |
| [BUG-034](high/BUG-034-data-loader-silent-swallow.md) | Data Loader Silent Swallow | ✅ Fixed | — |
| [BUG-031](high/BUG-031-action-executor-direct-property-access.md) | Action Executor Direct Property Access | ✅ Fixed | — |
| [BUG-028](high/BUG-028-socket-error-orphaned-mapping.md) | Socket Error Orphaned Mapping | ✅ Fixed | — |
| [BUG-026](high/BUG-026-blueprint-expansion-sibling-skipped.md) | Blueprint Expansion Sibling Skipped | ✅ Fixed | — |
| [BUG-021](high/BUG-021-spatial-action-race-condition.md) | Spatial Action Race Condition | ✅ Fixed | — |
| [BUG-010](high/BUG-010-self-target-resolution.md) | Self Target Resolution | ✅ Fixed | — |
| [BUG-009](high/BUG-009-server-direct-access.md) | Server Direct Access | ✅ Fixed | — |
| [BUG-008](high/BUG-008-state-desync.md) | State Desync | ✅ Fixed | — |
| [BUG-007](high/BUG-007-graceful-degradation.md) | Graceful Degradation | ✅ Fixed | — |
| [BUG-006](high/BUG-006-schema-validation-gap.md) | Schema Validation Gap | ✅ Fixed | — |
| [BUG-005](high/BUG-005-deep-trait-merge.md) | Deep Trait Merge | ✅ Fixed | — |
| [BUG-004](high/BUG-004-role-mismatch-skip.md) | Role Mismatch Skip | ✅ Fixed | — |
