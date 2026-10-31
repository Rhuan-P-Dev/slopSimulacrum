/**
 * escapeText - the client's HTML escaping helper.
 *
 * Every string this renders comes from outside the client: a card name typed
 * into a PNG by whoever made the card, a mod manifest's description, an error
 * message from the server. Panels here build markup with template strings, so
 * an unescaped value is markup the world wrote into the page. Anything that is
 * not ours goes through this.
 *
 * Client-only by design: the server never builds HTML (`CODE_RULES.md` H-5 keeps
 * it out of the API surface), so this lives under `public/` and is not in
 * `shared/`.
 *
 * @module public/utils/EscapeHtml
 */

/**
 * Escape a value for use as HTML text (not as an attribute containing code).
 * @param {*} value - Anything; non-strings are stringified first.
 * @returns {string} The value safe to drop between tags or inside a quoted attribute.
 */
export function escapeText(value) {
    if (value === null || value === undefined) return '';
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export default escapeText;
