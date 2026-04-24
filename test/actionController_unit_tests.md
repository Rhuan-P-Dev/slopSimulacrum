# ActionController Unit Test Plan

Comprehensive unit test specification for `src/controllers/actionController.js`, generated from deep analysis by 5 specialized subagents.

**Total Test Cases: 200+**

---

## Table of Contents
1. [Requirement Checking & Validation](#1-requirement-checking--validation)
2. [Scoring System](#2-scoring-system)
3. [Capability Cache Management](#3-capability-cache-management)
4. [Consequence Execution & Placeholder Resolution](#4-consequence-execution--placeholder-resolution)
5. [Event Subscription & Stat Change Notifications](#5-event-subscription--stat-change-notifications)

---

## 1. Requirement Checking & Validation

### 1.1 `_checkRequirements` — Entity-Wide Requirement Checking

#### Test 1.1.1: Single Component Satisfies All Requirements
- **What it tests:** When one component has all required trait.stat values >= minValue, requirements pass and that component is assigned as primary.
- **Setup/Mock:** Entity with one component having `strength.power = 10`, `agility.speed = 8`. Requirements: `[{trait: 'strength', stat: 'power', minValue: 5}, {trait: 'agility', stat: 'speed', minValue: 5}]`.
- **Expected Result:** `{passed: true, requirementValues: {'strength.power': 10, 'agility.speed': 8}, fulfillingComponents: {'strength.power': componentId, 'agility.speed': componentId}, componentId: componentId}`.
- **Edge Cases:** minValue equals actual value (boundary equality).

#### Test 1.1.2: Multiple Components Share Satisfying Requirements
- **What it tests:** When multiple components satisfy the same requirement, the scoring algorithm assigns the best component.
- **Setup/Mock:** Entity with two components: Component A satisfies `strength.power >= 5` and Component B also satisfies `strength.power >= 5`.
- **Expected Result:** Requirement assigned to component with higher score (both qualify equally, first by sort order).
- **Edge Cases:** Both components have identical stats.

#### Test 1.1.3: Requirements Split Across Multiple Components
- **What it tests:** Different components satisfy different requirements (multi-component fulfillment).
- **Setup/Mock:** Component A has `strength.power = 10`, Component B has `agility.speed = 8`. Requirements need both.
- **Expected Result:** `{passed: true, requirementValues: {'strength.power': 10, 'agility.speed': 8}, fulfillingComponents: {'strength.power': compA, 'agility.speed': compB}, componentId: compA}`.
- **Edge Cases:** Three or more components each satisfying different subsets.

#### Test 1.1.4: Entity Not Found
- **What it tests:** `_checkRequirements` returns ENTITY_NOT_FOUND error for non-existent entity.
- **Setup/Mock:** Call with `entityId = 'nonexistent'`.
- **Expected Result:** `{passed: false, error: {code: 'ENTITY_NOT_FOUND', details: {entityId: 'nonexistent'}}}`.

#### Test 1.1.5: Missing Trait Stat (No Component Has Required Value)
- **What it tests:** Returns MISSING_TRAIT_STAT when no component possesses the required trait.stat >= minValue.
- **Setup/Mock:** Entity exists but no component has `strength.power >= 5`.
- **Expected Result:** `{passed: false, error: {code: 'MISSING_TRAIT_STAT', details: {trait: 'strength', stat: 'power', minValue: 5}}}`.

#### Test 1.1.6: Entity With No Components
- **What it tests:** Entity exists but has empty components array.
- **Setup/Mock:** Entity with `components: []`.
- **Expected Result:** `{passed: false, error: {code: 'MISSING_TRAIT_STAT', ...}}`.

#### Test 1.1.7: Component With No Stats
- **What it tests:** Component exists but `getComponentStats` returns null/undefined.
- **Setup/Mock:** `getComponentStats` returns null for all components.
- **Expected Result:** `{passed: false, error: {code: 'MISSING_TRAIT_STAT', ...}}`.

#### Test 1.1.8: Zero minValue Requirements
- **What it tests:** Requirements with minValue = 0 should be satisfied by any defined stat.
- **Setup/Mock:** Requirement `{trait: 'strength', stat: 'power', minValue: 0}`. Component has `strength.power = 0`.
- **Expected Result:** `{passed: true}`.

#### Test 1.1.9: Negative minValue Requirements
- **What it tests:** Requirements with negative minValue.
- **Setup/Mock:** Requirement `{trait: 'strength', stat: 'power', minValue: -5}`. Component has `strength.power = -3`.
- **Expected Result:** `{passed: true}` (since -3 >= -5).

#### Test 1.1.10: Requirement Value Extraction Accuracy
- **What it tests:** requirementValues contains exact values from component stats, not minValue.
- **Setup/Mock:** Requirement minValue = 5, component has value = 10.
- **Expected Result:** `requirementValues['strength.power'] = 10` (not 5).

#### Test 1.1.11: Fulfilling Components Mapping Accuracy
- **What it tests:** fulfillingComponents correctly maps each trait.stat to the component that satisfies it.
- **Setup/Mock:** Multi-component scenario with clear ownership.
- **Expected Result:** Each key in fulfillingComponents maps to the correct component ID.

#### Test 1.1.12: Component Scoring and Sorting Logic
- **What it tests:** Components are scored by number of satisfied requirements and sorted descending.
- **Setup/Mock:** Component A satisfies 3 requirements, Component B satisfies 1, Component C satisfies 2.
- **Expected Result:** A assigned first, then C, then B for their respective requirements.

#### Test 1.1.13: Return Value Structure Validation
- **What it tests:** All required fields present in success result.
- **Setup/Mock:** Simple single-requirement scenario.
- **Expected Result:** Result has `passed`, `requirementValues`, `fulfillingComponents`, `componentId`.

#### Test 1.1.14: Multi-Trait Same Stat Fulfillment
- **What it tests:** Two requirements for different traits but same stat name.
- **Setup/Mock:** Requirements: `strength.power >= 5` and `agility.power >= 5`.
- **Expected Result:** Each assigned to best component independently.

### 1.2 `_checkRequirementsForComponent` — Single-Component Requirement Validation

#### Test 1.2.1: Single Component Satisfies All Requirements
- **What it tests:** Component has all required trait.stat values >= minValue.
- **Setup/Mock:** Component with `strength.power = 10`, `agility.speed = 8`. Requirements need both.
- **Expected Result:** `{passed: true, requirementValues: {...}, fulfillingComponents: {...}}`.

#### Test 1.2.2: Component Lacks One Requirement (Stricter Than _checkRequirements)
- **What it tests:** Component doesn't have all required traits — returns FAILED even if other components would.
- **Setup/Mock:** Component has `strength.power = 10` but NO `agility` trait. Requirement needs both.
- **Expected Result:** `{passed: false, error: {code: 'MISSING_TRAIT_STAT', details: {trait: 'agility', ...}}}`.

#### Test 1.2.3: Component Has Partial Traits
- **What it tests:** Component has some but not all required traits.
- **Setup/Mock:** Component has `strength.power = 10` but no `agility` trait. Requirements need both.
- **Expected Result:** `{passed: false, error: {code: 'MISSING_TRAIT_STAT', details: {trait: 'agility', ...}}}`.

#### Test 1.2.4: Component Stat Below minValue
- **What it tests:** Component has the trait but value < minValue.
- **Setup/Mock:** Component has `strength.power = 3`, requirement needs `minValue = 5`.
- **Expected Result:** `{passed: false, error: {code: 'MISSING_TRAIT_STAT', details: {trait: 'strength', stat: 'power', minValue: 5}}}`.

#### Test 1.2.5: Component With No Stats
- **What it tests:** `getComponentStats` returns null.
- **Setup/Mock:** `getComponentStats(componentId)` returns null.
- **Expected Result:** `{passed: false, error: {code: 'ENTITY_NOT_FOUND', details: {entityId}}}`.

#### Test 1.2.6: Exact Boundary Match
- **What it tests:** Value equals minValue exactly.
- **Setup/Mock:** Component has `strength.power = 5`, requirement needs `minValue = 5`.
- **Expected Result:** `{passed: true}`.

#### Test 1.2.7: Just Below Threshold
- **What it tests:** Value is minValue - 1 (or 0.99).
- **Setup/Mock:** Component has `strength.power = 4.99`, requirement needs `minValue = 5`.
- **Expected Result:** `{passed: false}`.

#### Test 1.2.8: Undefined Stat in Trait
- **What it tests:** Trait exists but specific stat is undefined.
- **Setup/Mock:** Component has `{strength: {power: 10}}` but requirement needs `strength.speed`.
- **Expected Result:** `{passed: false, error: {code: 'MISSING_TRAIT_STAT', ...}}`.

#### Test 1.2.9: Undefined Trait
- **What it tests:** Trait doesn't exist at all in component stats.
- **Setup/Mock:** Component has `{strength: {power: 10}}` but requirement needs `agility.speed`.
- **Expected Result:** `{passed: false, error: {code: 'MISSING_TRAIT_STAT', ...}}`.

#### Test 1.2.10: Comparison With _checkRequirements
- **What it tests:** `_checkRequirementsForComponent` is strictly stricter than `_checkRequirements`.
- **Setup/Mock:** Two components: A satisfies req1, B satisfies req2. `_checkRequirements` passes (multi-component), `_checkRequirementsForComponent` for either alone fails.
- **Expected Result:** `_checkRequirements` returns passed=true, `_checkRequirementsForComponent` returns passed=false for each individual component.

### 1.3 `checkRequirements` — Public API Wrapper

#### Test 1.3.1: Valid Action Name
- **What it tests:** Public API correctly delegates to `_checkRequirements`.
- **Setup/Mock:** Action exists in registry. Entity meets requirements.
- **Expected Result:** `{passed: true, ...}` with correct structure.

#### Test 1.3.2: Invalid Action Name
- **What it tests:** Returns ACTION_NOT_FOUND for unknown action.
- **Setup/Mock:** Call `checkRequirements('nonexistent', 'e1')`.
- **Expected Result:** `{passed: false, error: {code: 'ACTION_NOT_FOUND', details: {actionName: 'nonexistent'}}}`.

#### Test 1.3.3: Action With No Requirements
- **What it tests:** Action with empty or missing requirements array.
- **Setup/Mock:** Action has `requirements: []` or no requirements key.
- **Expected Result:** `{passed: true}` (no requirements to check).

### 1.4 Error Code Registry Tests

#### Test 1.4.1: ENTITY_NOT_FOUND Error Format
- **What it tests:** Error code produces correct message format.
- **Expected Result:** Message: `'Entity "{entityId}" not found.'`, level: `'ERROR'`.

#### Test 1.4.2: ACTION_NOT_FOUND Error Format
- **Expected Result:** Message: `'Action "{actionName}" not found.'`, level: `'ERROR'`.

#### Test 1.4.3: MISSING_TRAIT_STAT Error Format
- **Expected Result:** Message: `'No component possesses the required {trait}.{stat} (>= {minValue})'`, level: `'WARN'`.

#### Test 1.4.4: CONSEQUENCE_EXECUTION_FAILED Error Format
- **Expected Result:** Message: `'Failed to execute consequence {type}: {error}'`, level: `'ERROR'`.

#### Test 1.4.5: SYSTEM_RUNTIME_ERROR Error Format
- **Expected Result:** Message: `'An unexpected system error occurred: {error}'`, level: `'CRITICAL'`.

---

## 2. Scoring System

### Scoring Constants Reference
| Constant | Value | Description |
|----------|-------|-------------|
| `ACTION_SCORING.REQUIREMENT_MET` | 1.0 | Base score when requirement is met |
| `ACTION_SCORING.REQUIREMENT_EXCEEDED_BONUS` | 0.1 | Bonus multiplier for exceeding threshold |
| `ACTION_SCORING.CLOSE_TO_THRESHOLD_PENALTY` | -0.2 | Penalty for being close but not meeting |
| `ACTION_SCORING.EXCEEDED_THRESHOLD_MULTIPLIER` | 2.0 | Ratio threshold for bonus activation |
| `CLOSE_TO_THRESHOLD_FACTOR` | 1.25 | Close threshold factor (1/1.25 = 0.8 = 80%) |

**Key Threshold Calculations:**
- **Close threshold:** `value / minValue > 0.8` (i.e., value > 80% of minValue but < minValue)
- **Bonus threshold:** `value / minValue > 2.0` (i.e., value > 200% of minValue)

### 2.1 Single Requirement Scenarios

#### Test 2.1.1: Requirement Met Exactly (Boundary)
- **Setup:** `componentStats = {strength: {power: 10}}`, `requirements = [{trait: 'strength', stat: 'power', minValue: 10}]`.
- **Expected Result:** Score = `1.0` (REQUIREMENT_MET, no bonus, no penalty).

#### Test 2.1.2: Requirement Met With Moderate Excess (No Bonus)
- **Setup:** Value = 15, minValue = 10. Excess ratio = 1.5 (< 2.0 bonus threshold).
- **Expected Result:** Score = `1.0` (base only, no bonus since 1.5 <= 2.0).

#### Test 2.1.3: Requirement Met With High Excess (Bonus Applied)
- **Setup:** Value = 25, minValue = 10. Excess ratio = 2.5 (> 2.0 bonus threshold).
- **Expected Result:** Score = `1.0 + 0.1 * (2.5 - 1) = 1.0 + 0.15 = 1.15`.

#### Test 2.1.4: Requirement Met With Very High Excess
- **Setup:** Value = 100, minValue = 10. Excess ratio = 10.0.
- **Expected Result:** Score = `1.0 + 0.1 * (10.0 - 1) = 1.0 + 0.9 = 1.9`.

#### Test 2.1.5: Requirement Close But Not Met (Penalty Applied)
- **Setup:** Value = 9, minValue = 10. Ratio = 0.9 (> 0.8 close threshold).
- **Expected Result:** Score = `-0.2` (CLOSE_TO_THRESHOLD_PENALTY, no satisfiedCount so final = 0).
- **Note:** Since satisfiedCount = 0, final score = `0`.

#### Test 2.1.6: Requirement Far Below Threshold (No Penalty)
- **Setup:** Value = 5, minValue = 10. Ratio = 0.5 (< 0.8 close threshold).
- **Expected Result:** Score = `0` (not close enough for penalty, not satisfied, satisfiedCount = 0).

#### Test 2.1.7: Requirement At Exact Close Threshold Boundary
- **Setup:** Value = 8, minValue = 10. Ratio = 0.8 (exactly at threshold).
- **Expected Result:** Ratio 0.8 is NOT > 0.8, so no penalty. Score = `0`.

#### Test 2.1.8: Requirement Just Above Close Threshold
- **Setup:** Value = 8.01, minValue = 10. Ratio = 0.801 (> 0.8).
- **Expected Result:** Penalty applied but satisfiedCount = 0, so final = `0`.

### 2.2 Multiple Requirements Scenarios

#### Test 2.2.1: All Requirements Met
- **Setup:** 3 requirements, all satisfied. Values: 10, 15, 25. MinValues: 5, 10, 10.
- **Expected Result:** Score = `3.0 + bonuses` (3 * REQUIREMENT_MET + any excess bonuses).

#### Test 2.2.2: Some Requirements Met, Some Not
- **Setup:** 3 requirements: 1 met (value=10, min=5), 1 close (value=4, min=5), 1 far below (value=1, min=5).
- **Expected Result:** Score = `1.0 + penalty_if_close` but satisfiedCount = 1 > 0, so final = score with penalty.

#### Test 2.2.3: All Requirements Not Met
- **Setup:** 2 requirements, both below threshold and far below.
- **Expected Result:** Score = `0` (satisfiedCount = 0).

#### Test 2.2.4: All Requirements Not Met But All Close
- **Setup:** 2 requirements, both at 85% of minValue.
- **Expected Result:** Score = `-0.4` (2 * -0.2) but satisfiedCount = 0, so final = `0`.

### 2.3 Missing Data Scenarios

#### Test 2.3.1: Missing Trait
- **Setup:** Requirement needs `strength.power` but componentStats has no `strength` key.
- **Expected Result:** Score = `0` (trait skipped via `continue`).

#### Test 2.3.2: Missing Stat
- **Setup:** Requirement needs `strength.power` but componentStats.strength has no `power` key.
- **Expected Result:** Score = `0` (stat undefined, skipped via `continue`).

#### Test 2.3.3: Empty Requirements Array
- **Setup:** `componentStats = {strength: {power: 10}}`, `requirements = []`.
- **Expected Result:** Score = `0` (loop doesn't execute, satisfiedCount = 0).

#### Test 2.3.4: Component With No Matching Traits At All
- **Setup:** Requirement needs `strength.power`, component has only `agility.speed`.
- **Expected Result:** Score = `0`.

### 2.4 Edge Value Scenarios

#### Test 2.4.1: Zero minValue
- **Setup:** Requirement `{minValue: 0}`, component value = 0.
- **Expected Result:** Division by zero consideration: `excessRatio = 0 / 0 = NaN`. NaN > 2.0 is false. Score = `1.0` (0 >= 0 is true).
- **Note:** This is a potential bug — division by zero when minValue = 0.

#### Test 2.4.2: Zero component value with positive minValue
- **Setup:** Value = 0, minValue = 5. Ratio = 0.
- **Expected Result:** Score = `0` (0 < 5, not satisfied; ratio 0 < 0.8, no penalty; satisfiedCount = 0).

#### Test 2.4.3: Negative component value
- **Setup:** Value = -5, minValue = 5.
- **Expected Result:** Score = `0` (-5 < 5, not satisfied; ratio = -1 < 0.8, no penalty).

#### Test 2.4.4: Negative minValue
- **Setup:** Value = -3, minValue = -5. Ratio = 0.6.
- **Expected Result:** -3 >= -5 is true, satisfiedCount = 1, excessRatio = 0.6, 0.6 > 2.0 is false. Score = `1.0`.

#### Test 2.4.5: Decimal/non-integer values
- **Setup:** Value = 7.5, minValue = 5.0. Ratio = 1.5.
- **Expected Result:** Score = `1.0` (1.5 <= 2.0, no bonus).

#### Test 2.4.6: Very large values
- **Setup:** Value = 1000000, minValue = 1. Ratio = 1000000.
- **Expected Result:** Score = `1.0 + 0.1 * (1000000 - 1) = 99999.9`.

### 2.5 Consistency & Monotonicity

#### Test 2.5.1: Score Consistency
- **Setup:** Same input passed twice.
- **Expected Result:** Both calls return identical score.

#### Test 2.5.2: Score Monotonicity (Higher Values = Higher or Equal Scores)
- **Setup:** Value A = 10, Value B = 20, same minValue = 5.
- **Expected Result:** Score(B) >= Score(A).

#### Test 2.5.3: Score With Multiple Requirements Monotonicity
- **Setup:** Component A satisfies 2 requirements, Component B satisfies same 2 but with higher excess.
- **Expected Result:** Score(B) >= Score(A).

---

## 3. Capability Cache Management

### 3.1 `scanAllCapabilities` — Full Bottom-Up Scan

#### Test 3.1.1: Single Entity With Single Qualifying Component
- **Setup:** 1 entity, 1 component that meets action requirements.
- **Expected Result:** `_capabilityCache[actionName]` contains exactly 1 entry.

#### Test 3.1.2: Single Entity With Single Non-Qualifying Component
- **Setup:** Component stats below all requirement thresholds.
- **Expected Result:** `_capabilityCache[actionName]` is empty array `[]`.

#### Test 3.1.3: Single Entity With Multiple Components
- **Setup:** Entity with 3 components: 2 qualify for action A, 1 qualifies for action B.
- **Expected Result:** Action A cache has 2 entries, Action B cache has 1 entry.

#### Test 3.1.4: Multiple Entities With Multiple Components Each
- **Setup:** 3 entities, each with 2 components, varied stats.
- **Expected Result:** Cache populated with all qualifying entries across all entities.

#### Test 3.1.5: Entity With No Components
- **Setup:** Entity exists but `components: []`.
- **Expected Result:** No entries generated for this entity.

#### Test 3.1.6: Entity With Null Components
- **Setup:** Entity exists but `components: null`.
- **Expected Result:** No crash, no entries generated.

#### Test 3.1.7: Action With No Requirements
- **Setup:** Action has `requirements: []` or no requirements key.
- **Expected Result:** Action skipped (line 129: `if (!actionData.requirements || actionData.requirements.length === 0) continue`).

#### Test 3.1.8: Component With No Stats
- **Setup:** `getComponentStats` returns null for a component.
- **Expected Result:** Component skipped (line 126: `if (!componentStats) continue`).

#### Test 3.1.9: Empty State (No Entities)
- **Setup:** `state.entities = {}`.
- **Expected Result:** All action caches are empty arrays.

#### Test 3.1.10: Null State
- **Setup:** `state = null` or `state = undefined`.
- **Expected Result:** Graceful handling via `state.entities || {}`.

#### Test 3.1.11: Cache Initialization For Each Action
- **Setup:** 3 actions registered.
- **Expected Result:** `_capabilityCache` has exactly 3 keys, each with empty array before scan.

#### Test 3.1.12: Full Scan Returns Cache Reference
- **Expected Result:** Return value is the same reference as `this._capabilityCache`.

### 3.2 `reEvaluateActionForComponent` — Single Entry Update/Remove

#### Test 3.2.1: Score Improves (Entry Updated With Higher Score)
- **Setup:** Component already in cache for action. Stats increase.
- **Expected Result:** Entry updated with new higher score, array re-sorted.

#### Test 3.2.2: Score Worsens But Still Qualifies
- **Setup:** Component in cache. Stats decrease but still meet requirements.
- **Expected Result:** Entry updated with lower score, position in sorted array may change.

#### Test 3.2.3: Score Drops To Zero (Entry Removed)
- **Setup:** Component in cache. Stats decrease below requirement threshold.
- **Expected Result:** Entry removed from array, method returns `null`.

#### Test 3.2.4: Requirements No Longer Met (Entry Removed)
- **Setup:** Component had all required traits, now missing one.
- **Expected Result:** Entry removed, method returns `null`.

#### Test 3.2.5: New Entry Added (Wasn't In Cache Before)
- **Setup:** Component stats increase to meet requirements for first time.
- **Expected Result:** New entry pushed to array, method returns new entry.

#### Test 3.2.6: Entry Position Changes In Sorted Array
- **Setup:** Component score changes such that it's no longer the best.
- **Expected Result:** Entry moved to correct sorted position.

#### Test 3.2.7: Action Doesn't Exist In Registry
- **Setup:** Call with unknown actionName.
- **Expected Result:** Returns `null` (line 191: `if (!actionData) return null`).

#### Test 3.2.8: Component Stats Not Found
- **Setup:** `getComponentStats` returns null.
- **Expected Result:** Returns `null`.

#### Test 3.2.9: Component Not Found In Any Entity
- **Setup:** Component ID doesn't belong to any entity.
- **Expected Result:** Returns `null` (targetEntityId remains null).

#### Test 3.2.10: Existing Entry Updated In Place (Not Replaced)
- **Setup:** Entry exists in array.
- **Expected Result:** Same array index updated, not new array created.

### 3.3 `reEvaluateEntityCapabilities` — Re-Scan All Components For Entity

#### Test 3.3.1: Entity With Multiple Components
- **Setup:** Entity with 3 components, varied stats.
- **Expected Result:** All qualifying entries re-scanned and updated.

#### Test 3.3.2: Entity With No Components
- **Setup:** Entity with `components: []`.
- **Expected Result:** Returns empty array, no cache entries.

#### Test 3.3.3: Entity Doesn't Exist
- **Setup:** Call with unknown entityId.
- **Expected Result:** Returns empty array.

#### Test 3.3.4: Removes Old Entries Before Re-Scanning
- **Setup:** Entity has old entries in cache.
- **Expected Result:** Old entries removed first, then fresh entries added.

#### Test 3.3.5: Returns Updated Entries Array
- **Expected Result:** Array of all new/updated capability entries for the entity.

#### Test 3.3.6: Notifies Subscribers For Each Updated Entry
- **Setup:** Subscriber registered for actions the entity qualifies for.
- **Expected Result:** Subscriber called for each updated entry.

### 3.4 `removeEntityFromCache` / `_removeEntityFromAllActionCaches`

#### Test 3.4.1: Entity Exists In Cache
- **Setup:** Entity has entries in multiple action caches.
- **Expected Result:** All entries for entity removed from all actions.

#### Test 3.4.2: Entity Doesn't Exist In Cache
- **Setup:** Entity never had any entries.
- **Expected Result:** No error, no changes to cache.

#### Test 3.4.3: Entity In Single Action Cache
- **Setup:** Entity has entries in only one action.
- **Expected Result:** Only that action's array is modified.

#### Test 3.4.4: Entity With Multiple Entries Per Action
- **Setup:** Entity has multiple components qualifying for same action.
- **Expected Result:** All entries for entity removed from that action's array.

### 3.5 Getter Methods

#### Test 3.5.1: `getBestComponentForAction` — Has Entries
- **Expected Result:** Returns first entry (highest score).

#### Test 3.5.2: `getBestComponentForAction` — No Entries For Action
- **Expected Result:** Returns `null`.

#### Test 3.5.3: `getBestComponentForAction` — Action Doesn't Exist
- **Expected Result:** Returns `null`.

#### Test 3.5.4: `getAllCapabilitiesForAction` — Has Entries
- **Expected Result:** Returns array of all entries for action.

#### Test 3.5.5: `getAllCapabilitiesForAction` — No Entries
- **Expected Result:** Returns empty array `[]`.

#### Test 3.5.6: `getAllCapabilitiesForAction` — Action Doesn't Exist
- **Expected Result:** Returns empty array `[]`.

#### Test 3.5.7: `getCapabilitiesForEntity` — Entity Has Entries Across Multiple Actions
- **Expected Result:** Array of all entries for entity from all actions.

#### Test 3.5.8: `getCapabilitiesForEntity` — Entity Has No Entries
- **Expected Result:** Empty array `[]`.

#### Test 3.5.9: `getCapabilitiesForEntity` — Entity Doesn't Exist
- **Expected Result:** Empty array `[]`.

#### Test 3.5.10: `getCachedCapabilities` — Returns Reference
- **Expected Result:** Returns same reference as `this._capabilityCache`.

### 3.6 Auto-Scan Behavior

#### Test 3.6.1: `getActionsForEntity` — Entity In Cache (No Re-Scan)
- **Setup:** Entity exists in cache.
- **Expected Result:** Returns filtered actions without triggering full scan.

#### Test 3.6.2: `getActionsForEntity` — Entity NOT In Cache (Triggers Re-Scan)
- **Setup:** Entity exists in state but not in cache.
- **Expected Result:** Full scan triggered, then returns filtered actions.

#### Test 3.6.3: `getActionsForEntity` — Cache Empty (Triggers Re-Scan)
- **Setup:** `_capabilityCache` is empty object.
- **Expected Result:** Full scan triggered.

#### Test 3.6.4: `getActionsForEntity` — Entity Exists But Can't Execute Action
- **Setup:** Entity exists, action has no qualifying entries for entity.
- **Expected Result:** `cannotExecute` array populated with entity info, `canExecute` is empty.

#### Test 3.6.5: `getActionCapabilities` — Cache Empty (Triggers Re-Scan)
- **Expected Result:** Full scan triggered, returns all action capabilities.

#### Test 3.6.6: `getActionCapabilities` — Cache Has Data (No Re-Scan)
- **Expected Result:** Returns cached data without re-scan.

### 3.7 `_entityExistsInCache`

#### Test 3.7.1: Entity In Some Action's Cache
- **Expected Result:** Returns `true`.

#### Test 3.7.2: Entity In No Cache
- **Expected Result:** Returns `false`.

#### Test 3.7.3: Empty Cache
- **Expected Result:** Returns `false`.

### 3.8 Entry Structure Validation

#### Test 3.8.1: All Required Fields Present In Entry
- **Expected Result:** Each entry has: `entityId`, `componentId`, `componentType`, `componentIdentifier`, `score`, `requirementValues`, `fulfillingComponents`, `requirementsStatus`.

#### Test 3.8.2: `requirementsStatus` Field Accuracy
- **Expected Result:** Each item in `requirementsStatus` has: `trait`, `stat`, `current`, `required`.

#### Test 3.8.3: `componentIdentifier` Defaults To 'default'
- **Setup:** Component has no `identifier` property.
- **Expected Result:** `componentIdentifier = 'default'`.

### 3.9 Sorting Verification

#### Test 3.9.1: Entries Sorted By Score Descending
- **Setup:** Multiple entities qualifying for same action with different scores.
- **Expected Result:** Array ordered: highest score first.

#### Test 3.9.2: Sorting Maintained After Update
- **Setup:** Update an entry's score to be higher than existing entries.
- **Expected Result:** Entry moves to correct position.

#### Test 3.9.3: Sorting Maintained After Insertion
- **Setup:** Insert new entry with score between existing entries.
- **Expected Result:** Entry placed at correct sorted position.

---

## 4. Consequence Execution & Placeholder Resolution

### 4.1 `executeAction` — Success Scenarios

#### Test 4.1.1: Action Exists, Requirements Pass (Entity-Wide Path)
- **Setup:** Action in registry, entity meets requirements via multi-component fulfillment.
- **Expected Result:** `{success: true, action: actionName, entityId: id, ...consequenceResult}`.

#### Test 4.1.2: Action Exists, Requirements Pass (attackerComponentId Path)
- **Setup:** Action with `attackerComponentId` in params. Attacker component meets requirements.
- **Expected Result:** Success, attacker's stats used for requirement values.

#### Test 4.1.3: Action Exists, Requirements Pass (targetComponentId Path)
- **Setup:** Action with `targetComponentId` in params (legacy path).
- **Expected Result:** Success, target's stats used for requirement values.

#### Test 4.1.4: FulfillingComponents Passed To Context
- **Expected Result:** `context.fulfillingComponents` contains correct mapping in consequence handler call.

#### Test 4.1.5: RequirementValues Passed To Context
- **Expected Result:** `context.requirementValues` contains correct trait.stat → value mapping.

#### Test 4.1.6: ActionParams Passed To Context
- **Expected Result:** `context.actionParams` contains original params.

#### Test 4.1.7: Empty Params Object
- **Setup:** `executeAction('punch', 'e1', {})`.
- **Expected Result:** Falls back to entity-wide requirement checking.

#### Test 4.1.8: No Params Passed (Undefined)
- **Setup:** `executeAction('punch', 'e1')`.
- **Expected Result:** Default `params = {}` applied.

### 4.2 `executeAction` — Failure Scenarios

#### Test 4.2.1: Action Doesn't Exist
- **Setup:** `executeAction('nonexistent', 'e1')`.
- **Expected Result:** `{success: false, error: 'Action "nonexistent" not found.'}`.

#### Test 4.2.2: Requirements Fail (attackerComponentId Path)
- **Setup:** `attackerComponentId` provided but component doesn't meet requirements.
- **Expected Result:** `{success: false, error: 'Requirement failed: ...', executedFailureConsequences: ...}`.

#### Test 4.2.3: Requirements Fail (targetComponentId Path)
- **Setup:** `targetComponentId` provided but component doesn't meet requirements.
- **Expected Result:** Failure result with failure consequences executed.

#### Test 4.2.4: Requirements Fail (Entity-Wide Path)
- **Setup:** No attacker/target component, entity-wide check fails.
- **Expected Result:** Failure result with failure consequences executed.

#### Test 4.2.5: System Error In executeAction (Catch Block)
- **Setup:** Mock throws error during execution.
- **Expected Result:** `{success: false, error: 'An unexpected system error occurred: ...'}`.

#### Test 4.2.6: Priority — attackerComponentId Overrides targetComponentId
- **Setup:** Both `attackerComponentId` and `targetComponentId` provided.
- **Expected Result:** `attackerComponentId` used for requirement checking (highest priority).

#### Test 4.2.7: Priority — targetComponentId Overrides Entity-Wide
- **Setup:** Only `targetComponentId` provided, no `attackerComponentId`.
- **Expected Result:** `targetComponentId` used for requirement checking.

### 4.3 `_executeConsequences` — Success Consequence Execution

#### Test 4.3.1: Single Consequence Type
- **Setup:** Action with one consequence (e.g., `updateSpatial`).
- **Expected Result:** `{success: true, executedConsequences: 1, results: [{success: true, type: 'updateSpatial', ...}]}`.

#### Test 4.3.2: Multiple Consequence Types
- **Setup:** Action with 3 consequences of different types.
- **Expected Result:** `{success: true, executedConsequences: 3, results: [...]}`.

#### Test 4.3.3: Handler Doesn't Exist (Unknown Type)
- **Setup:** Consequence type not in `consequenceHandlers.handlers`.
- **Expected Result:** Result: `{success: false, error: 'Unknown consequence type: "..."', type: '...'}`.

#### Test 4.3.4: Handler Throws Error
- **Setup:** Handler function throws exception.
- **Expected Result:** Result: `{success: false, error: 'Failed to execute consequence ...', type: '...'}`.

#### Test 4.3.5: Action Has No Consequences
- **Setup:** Action with no `consequences` key.
- **Expected Result:** `{success: false, error: 'Action "..." has no consequences defined.'}`.

#### Test 4.3.6: Action Doesn't Exist
- **Setup:** Action not in registry.
- **Expected Result:** `{success: false, error: 'Action "..." has no consequences defined.'}`.

#### Test 4.3.7: Mixed Success And Failure
- **Setup:** Multiple consequences, some succeed, some fail (handler missing).
- **Expected Result:** `executedConsequences` counts only successful ones, results array has mixed success/failure.

#### Test 4.3.8: All Consequences Fail
- **Setup:** All consequence types unknown.
- **Expected Result:** All results have `success: false`.

#### Test 4.3.9: Context Object Structure Validation
- **Expected Result:** Context has `requirementValues`, `actionParams`, `fulfillingComponents`.

### 4.4 `_resolvePlaceholders` — Placeholder Resolution

#### Test 4.4.1: Exact Placeholder Match
- **Setup:** `params = ':Movement.move'`, `requirementValues = {'Movement.move': 10}`.
- **Expected Result:** `10` (number).

#### Test 4.4.2: Placeholder With Negative Sign
- **Setup:** `params = ':-:Physical.strength'`, `requirementValues = {'Physical.strength': 25}`.
- **Expected Result:** `-25` (number).

#### Test 4.4.3: Placeholder With Multiplier
- **Setup:** `params = ':Physical.strength*-2'`, `requirementValues = {'Physical.strength': 25}`.
- **Expected Result:** `-50` (number).

#### Test 4.4.4: Placeholder With Positive Multiplier
- **Setup:** `params = ':Physical.strength*3'`, `requirementValues = {'Physical.strength': 25}`.
- **Expected Result:** `75` (number).

#### Test 4.4.5: Embedded Placeholder In String
- **Setup:** `params = 'move :Movement.move units'`, `requirementValues = {'Movement.move': 10}`.
- **Expected Result:** `'move 10 units'` (string).

#### Test 4.4.6: Multiple Embedded Placeholders In One String
- **Setup:** `params = ':Physical.strength - :Agility.speed'`, `requirementValues = {'Physical.strength': 25, 'Agility.speed': 10}`.
- **Expected Result:** `'25 - 10'` (string).

#### Test 4.4.7: Undefined Placeholder Value (Keep Original)
- **Setup:** `params = ':NonExistent.stat'`, `requirementValues = {}`.
- **Expected Result:** `':NonExistent.stat'` (original string kept, with console.warn).

#### Test 4.4.8: Non-Numeric Placeholder Value (Keep Original)
- **Setup:** `requirementValues = {'Movement.move': 'not_a_number'}`.
- **Expected Result:** `':Movement.move'` (original string kept, with console.warn).

#### Test 4.4.9: Null Input
- **Expected Result:** `null` (passthrough).

#### Test 4.4.10: Undefined Input
- **Expected Result:** `undefined` (passthrough).

#### Test 4.4.11: Number Input (Passthrough)
- **Setup:** `params = 42`.
- **Expected Result:** `42`.

#### Test 4.4.12: Array With Placeholders
- **Setup:** `params = [':Strength.power', ':Agility.speed']`.
- **Expected Result:** `[10, 8]` (resolved numbers).

#### Test 4.4.13: Nested Object With Placeholders
- **Setup:** `params = {damage: ':Physical.strength', range: ':Movement.move'}`.
- **Expected Result:** `{damage: 25, range: 10}`.

#### Test 4.4.14: Mixed Array (Strings, Numbers, Objects)
- **Setup:** `params = [':Strength.power', 42, {nested: ':Agility.speed'}]`.
- **Expected Result:** `[10, 42, {nested: 8}]`.

#### Test 4.4.15: Empty String
- **Setup:** `params = ''`.
- **Expected Result:** `''` (empty string returned).

#### Test 4.4.16: String With No Placeholders
- **Setup:** `params = 'hello world'`.
- **Expected Result:** `'hello world'` (unchanged).

#### Test 4.4.17: Malformed Placeholder Pattern
- **Setup:** `params = ':invalid'` (missing dot and stat).
- **Expected Result:** `':invalid'` (unchanged, doesn't match regex).

#### Test 4.4.18: Placeholder With Extra Characters
- **Setup:** `params = ':Physical.strength!'`.
- **Expected Result:** `':Physical.strength!'` (doesn't match exact pattern due to `!`).

#### Test 4.4.19: Zero Value Placeholder
- **Setup:** `params = ':Movement.move'`, `requirementValues = {'Movement.move': 0}`.
- **Expected Result:** `0` (number zero).

#### Test 4.4.20: Negative Value Placeholder
- **Setup:** `params = ':Physical.strength'`, `requirementValues = {'Physical.strength': -25}`.
- **Expected Result:** `-25` (negative number).

#### Test 4.4.21: Decimal Value Placeholder
- **Setup:** `params = ':Movement.move'`, `requirementValues = {'Movement.move': 5.5}`.
- **Expected Result:** `5.5` (decimal number).

#### Test 4.4.22: Combined Sign And Multiplier
- **Setup:** `params = ':-:Physical.strength*2'`, `requirementValues = {'Physical.strength': 25}`.
- **Expected Result:** `-50` (negative * value * multiplier).

### 4.5 `_executeFailureConsequences`

#### Test 4.5.1: Has Failure Consequences
- **Setup:** Action with `failureConsequences` array.
- **Expected Result:** `{success: false, executedFailureConsequences: N, results: [...]}`.

#### Test 4.5.2: No Failure Consequences
- **Setup:** Action with no `failureConsequences` key.
- **Expected Result:** `{success: false, error: 'Action "..." has no failure consequences defined.'}`.

#### Test 4.5.3: Action Doesn't Exist
- **Setup:** Action not in registry.
- **Expected Result:** `{success: false, error: 'Action "..." has no failure consequences defined.'}`.

#### Test 4.5.4: Empty Failure Consequences Array
- **Setup:** `failureConsequences: []`.
- **Expected Result:** `{success: false, executedFailureConsequences: 0, results: []}`.

### 4.6 `_resolveError` — Error Resolution

#### Test 4.6.1: Known Error Code
- **Setup:** `{code: 'ENTITY_NOT_FOUND', details: {entityId: 'e1'}}`.
- **Expected Result:** `'Entity "e1" not found.'`.

#### Test 4.6.2: Unknown Error Code
- **Setup:** `{code: 'UNKNOWN_CODE', details: {}}`.
- **Expected Result:** `'An undefined error occurred.'`.

#### Test 4.6.3: Error With No Details
- **Setup:** `{code: 'ENTITY_NOT_FOUND'}`.
- **Expected Result:** `'Entity "{entityId}" not found.'` (placeholders not replaced).

#### Test 4.6.4: Error With No Code
- **Setup:** `{details: {entityId: 'e1'}}`.
- **Expected Result:** `'An unknown error occurred.'`.

#### Test 4.6.5: Null Error
- **Setup:** `null`.
- **Expected Result:** `'An unknown error occurred.'`.

#### Test 4.6.6: Undefined Error
- **Setup:** `undefined`.
- **Expected Result:** `'An unknown error occurred.'`.

#### Test 4.6.7: Error Level Logging
- **Setup:** ERROR code triggers `Logger.error()`.
- **Expected Result:** Logger.error called with formatted message.

#### Test 4.6.8: CRITICAL Error Level Logging
- **Setup:** SYSTEM_RUNTIME_ERROR triggers `Logger.critical()`.
- **Expected Result:** Logger.critical called with formatted message.

---

## 5. Event Subscription & Stat Change Notifications

### 5.1 `on()` — Subscribe to Capability Change Events

#### Test 5.1.1: Subscribe to Non-Existent Action
- **Setup:** Call `actionController.on('nonExistent', callback)`.
- **Expected Result:** `_actionSubscribers` Map contains key `'nonExistent'` with array containing callback.

#### Test 5.1.2: Subscribe to Existing Action
- **Setup:** Call `actionController.on('punch', callback)`.
- **Expected Result:** Subscriber registered for `'punch'`.

#### Test 5.1.3: Subscribe With Non-Function Callback (Ignored)
- **Setup:** `actionController.on('punch', 'not_a_function')`.
- **Expected Result:** No subscriber added (early return on line 573).

#### Test 5.1.4: Subscribe Same Callback Twice (No Duplication)
- **Setup:** Register same function reference twice.
- **Expected Result:** Callback appears only once in subscriber array.

#### Test 5.1.5: Subscribe Multiple Callbacks to Same Action
- **Setup:** Register 3 different callbacks for `'punch'`.
- **Expected Result:** All 3 callbacks in array.

#### Test 5.1.6: Subscribe to Multiple Different Actions
- **Setup:** Register callbacks for `'punch'` and `'dash'`.
- **Expected Result:** Separate subscriber arrays for each action.

### 5.2 `off()` — Unsubscribe from Events

#### Test 5.2.1: Remove Existing Callback
- **Setup:** Register callback, then call `off`.
- **Expected Result:** Callback removed from subscriber array.

#### Test 5.2.2: Remove Non-Existent Callback
- **Setup:** Call `off` with callback that was never registered.
- **Expected Result:** No error, no changes.

#### Test 5.2.3: Remove Callback from Non-Existent Action
- **Setup:** Call `off('nonExistent', callback)`.
- **Expected Result:** No error, no changes.

#### Test 5.2.4: Unsubscribe Removes Callback from Array (Memory)
- **Setup:** Register callback, unsubscribe, check array length.
- **Expected Result:** Array length decreased by 1.

### 5.3 `_notifySubscribers` — Subscriber Notification

#### Test 5.3.1: Single Subscriber
- **Setup:** One subscriber registered. Call `_notifySubscribers`.
- **Expected Result:** Callback invoked with `(actionName, capability)`.

#### Test 5.3.2: Multiple Subscribers
- **Setup:** Three subscribers registered.
- **Expected Result:** All three callbacks invoked.

#### Test 5.3.3: Subscriber Throws Error (Doesn't Affect Others)
- **Setup:** Subscriber A throws error, Subscriber B is normal.
- **Expected Result:** Subscriber B still called. Error logged via `Logger.error`.

#### Test 5.3.4: No Subscribers Registered
- **Setup:** No callbacks registered for action.
- **Expected Result:** No error, no crashes.

#### Test 5.3.5: Capability Is ComponentCapabilityEntry
- **Setup:** Notify with valid entry object.
- **Expected Result:** Callback receives the entry object.

#### Test 5.3.6: Capability Is RemovalMarker
- **Setup:** Notify with `{_type: 'REMOVAL', componentId: 'c1', entityId: 'e1'}`.
- **Expected Result:** Callback receives RemovalMarker object.

#### Test 5.3.7: Capability Is null
- **Setup:** Notify with `null`.
- **Expected Result:** Callback receives `null`.

### 5.4 `onStatChange` — Stat Change Handler

#### Test 5.4.1: Stat Changes, Dependent Actions Exist
- **Setup:** Component stat changes, action depends on that trait.stat.
- **Expected Result:** `reEvaluateActionForComponent` called for dependent action.

#### Test 5.4.2: Stat Changes, No Dependent Actions
- **Setup:** Stat changes, no action depends on that trait.stat.
- **Expected Result:** No re-evaluation calls.

#### Test 5.4.3: newValue === oldValue (Early Return)
- **Setup:** `onStatChange('c1', 'strength', 'power', 10, 10)`.
- **Expected Result:** No re-evaluation (early return on line 647).

#### Test 5.4.4: Stat Changes, Component Not Found
- **Setup:** Component ID doesn't exist.
- **Expected Result:** `reEvaluateActionForComponent` returns null, no crashes.

#### Test 5.4.5: Multiple Stats Change At Once
- **Setup:** Multiple `onStatChange` calls in sequence.
- **Expected Result:** Each triggers independent re-evaluation.

#### Test 5.4.6: Stat Changes From Undefined To Defined
- **Setup:** `oldValue = undefined`, `newValue = 10`.
- **Expected Result:** Re-evaluation triggered (undefined !== 10).

#### Test 5.4.7: Stat Changes From Defined To Undefined
- **Setup:** `oldValue = 10`, `newValue = undefined`.
- **Expected Result:** Re-evaluation triggered.

### 5.5 `_getActionsForTraitStat` — Reverse Index Lookup

#### Test 5.5.1: Trait.Stat Has Dependent Actions
- **Setup:** Registry has action requiring `strength.power`.
- **Expected Result:** Returns `['punch']`.

#### Test 5.5.2: Trait.Stat Has No Dependents
- **Setup:** No action requires `agility.speed`.
- **Expected Result:** Returns `[]`.

#### Test 5.5.3: Invalid TraitId
- **Setup:** Lookup `'nonexistent.stat'`.
- **Expected Result:** Returns `[]`.

#### Test 5.5.4: Invalid StatName
- **Setup:** Lookup `'strength.nonexistent'`.
- **Expected Result:** Returns `[]`.

#### Test 5.5.5: Multiple Actions Depend on Same Trait.Stat
- **Setup:** Two actions require `strength.power`.
- **Expected Result:** Returns array with both action names.

### 5.6 `_getActionsForTraitStatFromComponent` — Component-Based Lookup

#### Test 5.6.1: Component With Stats
- **Setup:** Component has `strength.power = 10`, `agility.speed = 8`.
- **Expected Result:** Returns all actions depending on any of component's trait.stats.

#### Test 5.6.2: Component Not Found
- **Setup:** `getComponentStats` returns null.
- **Expected Result:** Returns `null`.

#### Test 5.6.3: Component With No Matching Stats
- **Setup:** Component has stats but no action depends on them.
- **Expected Result:** Returns `[]`.

#### Test 5.6.4: Component With Multiple Traits
- **Setup:** Component has 3 traits with multiple stats each.
- **Expected Result:** Returns all unique actions depending on any stat.

### 5.7 `_buildTraitStatActionIndex` — Index Construction

#### Test 5.7.1: Builds Correct Index From Registry
- **Setup:** Registry with 3 actions, each with different requirements.
- **Expected Result:** `_traitStatActionIndex` maps each trait.stat to correct action set.

#### Test 5.7.2: Registry With No Requirements
- **Setup:** All actions have no requirements.
- **Expected Result:** `_traitStatActionIndex` is empty Map.

#### Test 5.7.3: Empty Registry
- **Setup:** `actionRegistry = {}`.
- **Expected Result:** `_traitStatActionIndex` is empty Map.

#### Test 5.7.4: Multiple Actions Share Same Trait.Stat
- **Setup:** Two actions require `strength.power`.
- **Expected Result:** `_traitStatActionIndex.get('strength.power')` is Set with both action names.

#### Test 5.7.5: Index Rebuild On Constructor
- **Setup:** Constructor called with registry.
- **Expected Result:** `_traitStatActionIndex` built during construction.

### 5.8 `_removeComponentFromActionCache` — Removal With Notification

#### Test 5.8.1: Component Exists In Cache
- **Setup:** Component in action cache.
- **Expected Result:** Entry removed, subscriber notified with RemovalMarker.

#### Test 5.8.2: Component Doesn't Exist In Cache
- **Setup:** Component never in action cache.
- **Expected Result:** No changes, no notification.

#### Test 5.8.3: Only One Entry (Array Becomes Empty)
- **Setup:** Action cache has single entry for component.
- **Expected Result:** Array becomes `[]`, subscriber notified.

#### Test 5.8.4: RemovalMarker Contains Correct EntityId
- **Setup:** Component belongs to entity 'e1'.
- **Expected Result:** RemovalMarker has `entityId: 'e1'`.

### 5.9 `_removeEntityFromAllActionCaches` — Entity Removal

#### Test 5.9.1: Entity In Multiple Actions
- **Setup:** Entity has entries in 3 different action caches.
- **Expected Result:** Entity removed from all 3 arrays, subscribers notified for each.

#### Test 5.9.2: Entity In One Action
- **Setup:** Entity has entries in only one action.
- **Expected Result:** Only that action's array modified.

#### Test 5.9.3: Entity Not In Any Action
- **Setup:** Entity never had any entries.
- **Expected Result:** No changes to any cache.

#### Test 5.9.4: Entity With Multiple Entries Per Action
- **Setup:** Entity has 2 components qualifying for same action.
- **Expected Result:** Both entries removed from that action's array.

### 5.10 `_createRemovalMarker` — Removal Marker Creation

#### Test 5.10.1: Creates Correct Structure
- **Setup:** `_createRemovalMarker('c1', 'e1')`.
- **Expected Result:** `{_type: 'REMOVAL', componentId: 'c1', entityId: 'e1'}`.

#### Test 5.10.2: _type Field Is Always 'REMOVAL'
- **Expected Result:** `_type` property is the string `'REMOVAL'`.

#### Test 5.10.3: Contains Correct componentId
- **Expected Result:** `componentId` matches the passed argument.

#### Test 5.10.4: Contains Correct entityId
- **Expected Result:** `entityId` matches the passed argument.

#### Test 5.10.5: Multiple Component IDs (RemovalMarker from _removeEntityFromAllActionCaches)
- **Setup:** `_createRemovalMarker('multiple', 'e1')`.
- **Expected Result:** `{_type: 'REMOVAL', componentId: 'multiple', entityId: 'e1'}`.

### 5.11 Full Flow Integration Tests

#### Test 5.11.1: Stat Change → Re-Evaluate → Notify → Subscriber Receives Entry
- **Setup:** Component qualifies for action, subscriber registered. Stat changes to improve score.
- **Expected Result:** Subscriber receives updated ComponentCapabilityEntry.

#### Test 5.11.2: Stat Change → Re-Evaluate → Component Removed → Subscriber Receives RemovalMarker
- **Setup:** Component qualifies for action, subscriber registered. Stat changes to below threshold.
- **Expected Result:** Subscriber receives RemovalMarker.

#### Test 5.11.3: Subscriber Receives Correct actionName
- **Expected Result:** First callback argument matches the action being evaluated.

#### Test 5.11.4: Subscriber Receives Correct capability
- **Expected Result:** Second callback argument matches the updated entry or removal marker.

#### Test 5.11.5: off() After Notification — Callback No Longer Called
- **Setup:** Register, trigger notification, unregister, trigger again.
- **Expected Result:** Second notification does not reach callback.

#### Test 5.11.6: Full Flow — Component Stat Decrease Triggers Removal
- **Setup:** Component in cache, stat decreases below requirement.
- **Expected Result:** Entry removed, RemovalMarker sent to subscribers.

#### Test 5.11.7: Full Flow — Component Stat Increase Adds New Entry
- **Setup:** Component not in cache, stat increases to meet requirements.
- **Expected Result:** New entry added, ComponentCapabilityEntry sent to subscribers.

#### Test 5.11.8: Multiple Stats Change Triggers Multiple Re-Evaluations
- **Setup:** Component has two stats that are each depended on by different actions.
- **Expected Result:** Both actions re-evaluated, subscribers notified for each.

#### Test 5.11.9: Subscriber Error Isolation
- **Setup:** Subscriber A throws, Subscriber B doesn't.
- **Expected Result:** Both subscribers processed, A's error logged but doesn't prevent B's notification.

#### Test 5.11.10: onStatChange With Float Values
- **Setup:** `oldValue = 5.0`, `newValue = 5.00001`.
- **Expected Result:** Re-evaluation triggered (5.0 !== 5.00001).

---

## Appendix: Test Setup Guidelines

### Mocking Strategy
All tests should mock:
1. `worldStateController` — Provides `componentController` with `getComponentStats()`
2. `consequenceHandlers` — Provides `handlers` map with mock handler functions
3. `actionRegistry` — Provides action definitions with requirements and consequences

### Example Mock Setup
```javascript
const mockWorldStateController = {
    componentController: {
        getComponentStats: vi.fn(),
        registerStatChangeListener: vi.fn(),
        unregisterStatChangeListener: vi.fn()
    }
};

const mockConsequenceHandlers = {
    handlers: {
        updateSpatial: vi.fn(() => ({})),
        updateComponentStatDelta: vi.fn(() => ({}))
    }
};

const mockActionRegistry = {
    punch: {
        requirements: [{trait: 'strength', stat: 'power', minValue: 5}],
        consequences: [{type: 'updateSpatial', params: {x: ':Movement.move'}}]
    }
};

const actionController = new ActionController(
    mockWorldStateController,
    mockConsequenceHandlers,
    mockActionRegistry
);
```

### Testing Framework Recommendations
- Use **Vitest** (already configured in `vitest.config.js`)
- Use `vi.fn()` for mock functions
- Use `vi.mock()` for module mocking
- Group tests by method using `describe()` blocks
- Use `beforeEach()` for fresh mock setup per test

---

**Generated by:** 5 specialized test engineering subagents
**Date:** 2026-04-22
**Source:** `src/controllers/actionController.js`
**Quality Standards:** `wiki/code_quality_and_best_practices.md`
**Architecture Standards:** `wiki/subMDs/controller_patterns.md`, `wiki/CORE.md`