/**
 * ComponentNaming — shared component-type → display-name resolution.
 *
 * A component's display name derives from its *type* (the recipe key in
 * data/components/components.json, e.g. `centralBall` → "Central Ball"),
 * falling back to a prettified camelCase form when the recipe has no explicit
 * `name` (e.g. `droidHand` → "Droid Hand").
 *
 * This is the same naming source the consequence dispatcher uses for the
 * possessive combat-log phrases (`'s Central Ball`), so the perception
 * target line and the log can never name the same component differently.
 *
 * @module ComponentNaming
 */
import DataLoader from './DataLoader.js';

/**
 * Module-level recipe cache. Only a successful (non-empty) load is cached, so
 * a transient read failure (loadJsonSafe returning its default) is retried on
 * the next call instead of being cached for the process lifetime.
 * @type {Object<string, Object<string, {name?: string}>>|null}
 */
let recipes = null;

/**
 * Loads data/components/components.json via the shared safe loader (never
 * throws; returns the default on failure).
 * @returns {Object<string, Object<string, {name?: string}>>|null}
 */
function loadRecipes() {
    if (recipes) return recipes;
    const loaded = DataLoader.loadJsonSafe('data/components/components.json', null);
    if (loaded && typeof loaded === 'object' && Object.keys(loaded).length > 0) {
        recipes = loaded;
    }
    return loaded;
}

/**
 * Prettifies a camelCase recipe/type key into a readable name (droidHand →
 * "Droid Hand"). Used only when a recipe has no explicit `name`.
 *
 * @param {string|null|undefined} type
 * @returns {string|null}
 */
export function prettifyType(type) {
    if (!type || typeof type !== 'string') return null;
    return type.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Returns the display name for a component *type* (recipe key): the recipe's
 * explicit `name` when available, else the prettified key.
 *
 * @param {string|null|undefined} type - The component type (recipe key).
 * @returns {string|null} The display name, or null for invalid input.
 */
export function componentTypeName(type) {
    if (!type || typeof type !== 'string') return null;
    const table = loadRecipes();
    const def = table?.[type];
    if (def && typeof def.name === 'string' && def.name !== '') return def.name;
    return prettifyType(type);
}

export default { componentTypeName, prettifyType };
