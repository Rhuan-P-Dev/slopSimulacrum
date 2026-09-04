/**
 * WorldRulesController — Layer-0 data owner for the world-rules layer
 * (data/world_rules.json).
 *
 * Per the State Controller pattern (wiki/subMDs/controllers/controller_patterns.md §4),
 * this controller holds raw validated configuration and has NO cross-controller
 * dependencies: it is constructed by the composition root
 * (src/composition/WorldComposition.js) with the raw `data/world_rules.json`
 * content (loaded there via `DataLoader.loadJsonSafe('data/world_rules.json', {})`
 * — project rule §5). It performs no file I/O of its own.
 *
 * Responsibility: validate the rule registry at construction (WR-1/WR-5),
 * log the initialization summary (project rule §5.2), and expose null-tolerant
 * public readers that return defensive copies (controller_patterns §7).
 *
 * Deliberate divergence from the material files' boot-fail contract (WR-1):
 * a missing/empty/top-level-malformed file means ALL rules off and NO throw.
 * "Off" is a complete, consistent world state — the world as it ran before
 * the layer existed — so nothing is lost by degrading, and throwing would
 * turn a balance file into a crash vector for no benefit.
 *
 * Deliberately has NO `getAll()`: static configuration must stay out of the
 * world-state broadcast aggregation (same exclusion rule as CraftingController,
 * KnowledgeController, and RoomChatController).
 *
 * @module WorldRulesController
 */

import Logger from '../../utils/Logger.js';

/**
 * The known rule keys this server version can act on. A key in the file that
 * is not in this set is an unknown key → ignored with a warning (WR-1,
 * forward compatibility: a newer file may declare rules this server does not
 * yet recognize).
 * @type {ReadonlySet<string>}
 */
/**
 * The stable key of the shipped torn-material rule (WR-2), defined once so
 * the key cannot drift between the known-keys set and the rule reader.
 * @type {string}
 */
const DAMAGE_TORN_MATERIAL_RULE = 'damageTornMaterial';

const KNOWN_RULE_KEYS = new Set([DAMAGE_TORN_MATERIAL_RULE]);

class WorldRulesController {
    /**
     * @param {Object|null} rawRegistry - Raw data from data/world_rules.json
     *   (the loader's parsed object, or the fallback `{}` on a missing file).
     */
    constructor(rawRegistry) {
        this._rules = {};
        this._validateWorldRules(rawRegistry);
    }

    /**
     * Validates the world-rules registry (project rule §6, adapted for the
     * "off, never crash" degradation contract of WR-5).
     *
     * Outcomes:
     *   - null / undefined / non-object / array → all rules off, single warn,
     *     NO throw (WR-5: top-level malformed → off, complete state).
     *   - object with no `rules` key or empty `rules` → all rules off, warn.
     *   - `rules` present and a plain object → per-key validation:
     *       - `_`-prefixed keys are metadata, skipped (house convention).
     *       - Unknown rule key → ignored with a warn (forward compatibility).
     *       - Known key with a malformed config (missing `percent`, non-numeric
     *         / NaN / out-of-range `percent`, non-boolean `enabled`) → that
     *         rule off with a warn; every other rule unaffected.
     *       - `percent` = 0 or `enabled` = false → rule off by design (valid
     *         value, no warning).
     *
     * @param {Object|null} rawRegistry - The raw parsed file content.
     * @private
     */
    _validateWorldRules(rawRegistry) {
        // Missing / unreadable file → the loader's fallback ({}) or null.
        // All rules off; a single warn; the world is bit-identical to legacy.
        if (rawRegistry === null || rawRegistry === undefined) {
            Logger.warn('[WorldRulesController] world_rules registry is absent — all world rules off (legacy behavior).');
            this._logSummary();
            return;
        }

        // Top-level type check: must be a plain object (not array/null).
        // A wrong type is "top-level malformed" → all off, warn, NO throw (WR-5).
        if (typeof rawRegistry !== 'object' || Array.isArray(rawRegistry)) {
            Logger.warn(`[WorldRulesController] world_rules registry has unexpected type (${typeof rawRegistry}) — all world rules off (legacy behavior).`);
            this._logSummary();
            return;
        }

        // The `rules` section: absent or empty → all off, warn.
        const rules = rawRegistry.rules;
        if (rules === undefined || rules === null) {
            Logger.warn('[WorldRulesController] world_rules file has no "rules" section — all world rules off (legacy behavior).');
            this._logSummary();
            return;
        }
        if (typeof rules !== 'object' || Array.isArray(rules)) {
            Logger.warn('[WorldRulesController] world_rules "rules" section is not a plain object — all world rules off (legacy behavior).');
            this._logSummary();
            return;
        }
        if (Object.keys(rules).length === 0) {
            Logger.warn('[WorldRulesController] world_rules "rules" section is empty — all world rules off (legacy behavior).');
            this._logSummary();
            return;
        }

        // Per-key validation.
        for (const [key, config] of Object.entries(rules)) {
            // Skip metadata keys (house convention from the material files).
            if (key.startsWith('_')) continue;

            // Unknown rule key → ignore with a warn (forward compatibility, WR-1).
            if (!KNOWN_RULE_KEYS.has(key)) {
                Logger.warn(`[WorldRulesController] Unknown rule key "${key}" — ignored (this server version does not recognize it).`);
                continue;
            }

            // Known key: validate the config object.
            this._rules[key] = this._validateRuleConfig(key, config);
        }

        this._logSummary();
    }

    /**
     * Validates a single known rule's config object.
     *
     * For `damageTornMaterial`:
     *   - config must be a plain object (not array/null/wrong type) → else rule off.
     *   - `percent` (required): must be a finite number in [0, 100] → else rule off.
     *   - `enabled` (optional, default true): must be a boolean if present → else rule off.
     *   - Any other field is ignored (forward compatibility).
     *
     * @param {string} key - The rule key (for logging context).
     * @param {*} config - The raw config value from the file.
     * @returns {Object|null} The validated config, or null when the rule is off.
     * @private
     */
    _validateRuleConfig(key, config) {
        // Config must be a plain object.
        if (typeof config !== 'object' || config === null || Array.isArray(config)) {
            Logger.warn(`[WorldRulesController] Rule "${key}": config is not a plain object — rule disabled.`);
            return null;
        }

        // `percent` is required: must be a finite number in [0, 100].
        if (config.percent === undefined || config.percent === null) {
            Logger.warn(`[WorldRulesController] Rule "${key}": missing required field "percent" — rule disabled.`);
            return null;
        }
        if (typeof config.percent !== 'number' || !Number.isFinite(config.percent)) {
            Logger.warn(`[WorldRulesController] Rule "${key}": "percent" is not a finite number — rule disabled.`);
            return null;
        }
        if (config.percent < 0 || config.percent > 100) {
            Logger.warn(`[WorldRulesController] Rule "${key}": "percent" ${config.percent} is out of range [0, 100] — rule disabled.`);
            return null;
        }

        // `enabled` is optional (default true); if present must be a boolean.
        let enabled = true;
        if (config.enabled !== undefined) {
            if (typeof config.enabled !== 'boolean') {
                Logger.warn(`[WorldRulesController] Rule "${key}": "enabled" is not a boolean — rule disabled.`);
                return null;
            }
            enabled = config.enabled;
        }

        // Rule off by design (valid values, no warning).
        if (enabled === false || config.percent === 0) {
            return null;
        }

        return { percent: config.percent, enabled: true };
    }

    /**
     * Logs the initialization summary: how many rules are active vs off.
     * (project rule §5.2: always log initialization count via Logger.info()).
     * @private
     */
    _logSummary() {
        // Count only ACTIVE rules: a malformed / off-by-design rule is stored
        // as null under its key, so key-counting would over-report (the
        // (none) list below already filters those out).
        const active = Object.values(this._rules).filter(Boolean).length;
        const known = KNOWN_RULE_KEYS.size;
        Logger.info(`[WorldRulesController] initialized: ${active}/${known} rule(s) active (${[...KNOWN_RULE_KEYS].filter(k => this._rules[k]).join(', ') || 'none'}).`);
    }

    /**
     * Returns a defensive deep copy of the validated config for a rule key,
     * or null when the rule is inactive (off, unknown, or malformed).
     *
     * @param {string} key - The rule key (e.g. 'damageTornMaterial').
     * @returns {Object|null} A deep copy of the rule config, or null.
     */
    getRule(key) {
        const rule = this._rules[key];
        return rule ? { ...rule } : null;
    }

    /**
     * Whether a rule is active (validated, enabled, and not at percent 0).
     *
     * @param {string} key - The rule key.
     * @returns {boolean}
     */
    isRuleActive(key) {
        return this._rules[key] !== undefined && this._rules[key] !== null;
    }

    /**
     * Returns a defensive copy of the map of ACTIVE rules
     * (key → { percent, enabled } copy). Inactive rules (off / unknown /
     * malformed) are omitted, never null-valued. No I/O, no mutation.
     *
     * @returns {Object} A fresh map of active rule key → rule-config copy;
     *   `{}` when no rules are active.
     */
    getActiveRules() {
        const active = {};
        for (const [key, rule] of Object.entries(this._rules)) {
            if (rule) active[key] = { ...rule };
        }
        return active;
    }

    /**
     * Returns the active torn-material percentage for the `damageTornMaterial`
     * rule (the rule's core lever). Returns 0 when the rule is inactive
     * (file missing/empty/malformed, rule disabled, percent 0, or unwired
     * controller) — callers treat 0 as "no torn drops".
     *
     * @returns {number} The percentage (0–100); 0 means the rule is off.
     */
    getDamageTornMaterialPercent() {
        const rule = this._rules[DAMAGE_TORN_MATERIAL_RULE];
        return rule ? rule.percent : 0;
    }
}

export default WorldRulesController;
