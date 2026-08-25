import ClientLogger from '/utils/ClientLogger.js';

/**
 * MaterialRegistry — client-side cache for material definitions and blueprint compositions.
 *
 * Fetches GET /materials/registry once at startup (idempotent). Provides helpers to look up
 * materials by type and format display strings (e.g. "Iron 60% (blade)").
 *
 * Usage:
 *   await MaterialRegistry.load();          // call from App init or ComponentViewer.show()
 *   const comps = MaterialRegistry.getComposition(type);
 *   const name  = MaterialRegistry.getMaterialName('iron');
 *   const badge = MaterialRegistry.formatBadge({ material: 'iron', fraction: 0.6, role: 'blade' });
 */
const MaterialRegistry = (() => {
    /** @private {Object|null} */
    let _materials = null;
    /** @private {Object|null} */
    let _compositions = null;
    /** @private {boolean} */
    let _loaded = false;
    /** @private {Promise<void>|null} */
    let _pending = null;

    // HTML entity map for escaping
    const ESCAPE_MAP = {
        '&': String.fromCodePoint(38) + 'amp;',
        '<': String.fromCodePoint(60) + 'lt;',
        '>': String.fromCodePoint(62) + 'gt;',
        '"': String.fromCodePoint(34) + 'quot;',
        "'": String.fromCodePoint(39) + '#39;'
    };

    /** Escapes a value for safe HTML interpolation.
     * @param {*} value
     * @returns {string}
     */
    function escapeHtml(value) {
        const str = String(value);
        return str.replace(/[&<>"']/, c => ESCAPE_MAP[c]);
    }

    /**
     * Fetch the materials registry from the server (retryable — failures stay retryable).
     * @returns {Promise<void>}
     */
    async function load() {
        if (_loaded) return;
        if (_pending) return _pending; // coalesce concurrent callers

        _pending = (async () => {
            try {
                const response = await fetch('/materials/registry');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                if (!data || typeof data.materials !== 'object' || data.materials === null) {
                    throw new Error('malformed materials registry payload');
                }
                _materials = data.materials;
                _compositions = data.compositions && typeof data.compositions === 'object' ? data.compositions : {};
                _loaded = true; // success only — failures stay retryable

                const matCount = Object.keys(_materials).length;
                const compCount = Object.keys(_compositions).length;
                ClientLogger.info('MaterialRegistry', `Loaded ${matCount} material(s) and ${compCount} composition(s)`);
            } catch (err) {
                ClientLogger.warn('MaterialRegistry', `registry load failed (will retry on next ensureLoaded): ${err.message}`);
            } finally {
                _pending = null;
            }
        })();
        return _pending;
    }

    /**
     * Ensures the registry is loaded (convenience wrapper for callers that already await).
     * @returns {Promise<void>}
     */
    async function ensureLoaded() {
        if (!_loaded) await load();
    }

    /**
     * Get the materials composition array for a given blueprint type.
     * @param {string} type - The blueprint type (e.g. 'centralBall', 'knife').
     * @returns {Array|null} Array of { material, fraction, role? } or null if not found.
     */
    function getComposition(type) {
        return _compositions?.[type] ?? null;
    }

    /**
     * Get the display name for a material ID.
     * Falls back to the raw id if the definition is missing.
     * @param {string} materialId - The material id (e.g. 'iron').
     * @returns {string} Display name.
     */
    function getMaterialName(materialId) {
        const def = _materials?.[materialId];
        return def?.name || materialId;
    }

    /**
     * Format a single material entry as a display badge string.
     * e.g. "Iron 60% (blade)" or "Wood 40%" (no role).
     * @param {Object} entry - { material, fraction, role? }.
     * @returns {string} Formatted badge text.
     */
    function formatBadge(entry) {
        if (!entry || typeof entry !== 'object') return '';

        const name = escapeHtml(getMaterialName(entry.material));
        const percentage = Math.round(entry.fraction * 100);

        if (entry.role) {
            return `${name} ${percentage}% (${escapeHtml(entry.role)})`;
        }
        return `${name} ${percentage}%`;
    }

    /**
     * Format all compositions for a type as an HTML string of badge spans.
     * e.g. `<span class="material-badge">Iron 60% (blade)</span> <span class="material-badge">Wood 40% (handle)</span>`
     * @param {string} type - The blueprint type.
     * @returns {string} HTML string of badges, or empty string if no composition.
     */
    function formatBadges(type) {
        const comps = getComposition(type);
        if (!comps || !Array.isArray(comps) || comps.length === 0) return '';

        return comps.map(entry => {
            const materialName = escapeHtml(getMaterialName(entry.material));
            const fraction = escapeHtml(String(entry.fraction));
            const role = escapeHtml(entry.role || 'N/A');
            // formatBadge already escapes, so use it directly (not wrapped in escapeHtml)
            const badgeText = formatBadge(entry);
            return `<span class="material-badge" title="${materialName} (fraction: ${fraction}, role: ${role})">${badgeText}</span>`;
        }).join(' ');
    }

    return { load, ensureLoaded, getComposition, getMaterialName, formatBadge, formatBadges };
})();

export default MaterialRegistry;
