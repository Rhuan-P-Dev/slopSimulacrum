/**
 * RangeResolver — Shared, environment-agnostic range-expression resolver.
 *
 * SINGLE SOURCE OF TRUTH for resolving range expressions on BOTH the server and
 * the browser. It intentionally has NO Node.js APIs and NO DOM APIs, so the same
 * ES module can be imported by:
 *   - the Node server (relative file path import) and
 *   - the browser (served as a module via the `/shared/` static route).
 *
 * It resolves expressions of the form used in `data/actions.json`, e.g.:
 *   - plain numbers            -> "10", "3.5", "-2"
 *   - simple placeholders      -> ":Physical.strength"
 *   - placeholder * multiplier -> ":Physical.strength*2"
 *   - signed placeholders      -> "-:Physical.mass"
 *   - compound arithmetic      -> ":Physical.strength*2+3", "(2+3)*:Movement.move"
 *
 * Grammar (recursive descent, left-to-right, standard precedence):
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/') factor)*
 *   factor  := ('+' | '-') factor | primary
 *   primary := number | ':placeholder' | '(' expr ')'
 *
 * Semantics (per the FASE 0 contract):
 *   - A `:placeholder` that is NOT present in `statMap` (or maps to a non-finite
 *     number) makes the WHOLE expression unresolvable. `resolveRange` then returns
 *     the caller-supplied `fallback` value — it NEVER silently substitutes 0.
 *   - Arithmetic is evaluated with a hand-written recursive-descent parser.
 *     `Function()`, `eval`, `new Function`, `setTimeout(string)` etc. are NEVER used.
 *   - Any parse failure (unknown placeholder, bad token, division by zero, trailing
 *     garbage) yields the `fallback` value and emits a single console WARN.
 *
 * @module RangeResolver
 */

/**
 * Internal error type used to short-circuit parsing when a placeholder cannot be
 * resolved. It is not thrown to callers; `resolveRange` catches it and returns the
 * fallback value instead.
 */
class RangeResolveError extends Error {
    constructor(message) {
        super(message);
        this.name = 'RangeResolveError';
    }
}

/**
 * Strict numeric literal: optional sign, integer/decimal (optional), optional
 * exponent. Deliberately does not accept hex/leading-underscore so that only
 * unambiguous numbers take the fast path.
 * @type {RegExp}
 */
const NUMBER_LITERAL_REGEX = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Valid single character for a placeholder name after the leading ':' (trait.stat
 * or simple variable), e.g. `Physical.strength`, `Movement.move`, `entityId`.
 * @type {RegExp}
 */
const PLACEHOLDER_CHAR_REGEX = /^[a-zA-Z0-9_.]$/;

/**
 * Resolves a range expression into a number.
 *
 * @param {string|number} expression - A plain number, or a string expression such
 *   as ":Physical.strength*2+3". Numbers are returned as-is (the caller is
 *   responsible for validating positivity/finiteness).
 * @param {Object} statMap - Map of "trait.stat" (or ":variable") names to finite
 *   numeric values. May be `null`/`undefined` (treated as empty).
 * @param {number} fallback - Value returned when the expression is empty,
 *   non-string, or references an unknown placeholder. The resolver NEVER returns 0
 *   on its own; this is whatever the caller explicitly provides.
 * @returns {number} The resolved value, or `fallback` when unresolvable.
 */
export function resolveRange(expression, statMap, fallback) {
    // Numbers pass straight through (caller validates).
    if (typeof expression === 'number') {
        return expression;
    }

    // Non-string / empty / null / undefined -> fallback.
    if (expression === null || expression === undefined || typeof expression !== 'string') {
        return fallback;
    }

    const trimmed = expression.trim();
    if (trimmed === '') {
        return fallback;
    }

    // Fast path: the whole expression is a numeric literal.
    if (NUMBER_LITERAL_REGEX.test(trimmed)) {
        return Number(trimmed);
    }

    try {
        const tokens = _tokenize(trimmed);
        if (tokens.length === 0) {
            return fallback;
        }
        const parser = new _ExpressionParser(tokens, statMap || {});
        return parser.parse();
    } catch (error) {
        const reason = error instanceof RangeResolveError ? error.message : `invalid expression: ${error.message}`;
        // WARN (not error): an unresolvable range is expected/handled by callers.
        // `console.warn` is used (not the server Logger) so the module stays pure
        // and importable in the browser.
        console.warn(`[RangeResolver] Could not resolve range expression "${expression}" — ${reason}. Using fallback.`);
        return fallback;
    }
}

/**
 * Converts an expression string into a flat list of typed tokens.
 * @param {string} text - The trimmed expression.
 * @returns {Array<{type: string, value: number|string}>}
 * @throws {RangeResolveError} On any unexpected character.
 * @private
 */
function _tokenize(text) {
    const tokens = [];
    const length = text.length;
    let i = 0;

    while (i < length) {
        const ch = text[i];

        // Skip whitespace.
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            i += 1;
            continue;
        }

        // Operators and parentheses.
        if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')') {
            tokens.push({ type: ch, value: ch });
            i += 1;
            continue;
        }

        // Placeholder: ':' followed by one or more name characters.
        if (ch === ':') {
            let j = i + 1;
            while (j < length && PLACEHOLDER_CHAR_REGEX.test(text[j])) {
                j += 1;
            }
            if (j === i + 1) {
                throw new RangeResolveError('expected a placeholder name after ":"');
            }
            tokens.push({ type: ':placeholder', value: text.slice(i + 1, j) });
            i = j;
            continue;
        }

        // Number literal (integer, decimal, or exponent form).
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] || ''))) {
            let j = i;
            let seenDot = false;
            while (j < length && (/[0-9]/.test(text[j]) || (text[j] === '.' && !seenDot))) {
                if (text[j] === '.') {
                    seenDot = true;
                }
                j += 1;
            }
            // Optional exponent (only consumed when a digit follows the sign).
            if (j < length && (text[j] === 'e' || text[j] === 'E')) {
                let k = j + 1;
                if (k < length && (text[k] === '+' || text[k] === '-')) {
                    k += 1;
                }
                if (k < length && /[0-9]/.test(text[k])) {
                    while (k < length && /[0-9]/.test(text[k])) {
                        k += 1;
                    }
                    j = k;
                }
            }
            const numericText = text.slice(i, j);
            const numericValue = Number(numericText);
            if (!Number.isFinite(numericValue)) {
                throw new RangeResolveError(`invalid number literal "${numericText}"`);
            }
            tokens.push({ type: 'number', value: numericValue });
            i = j;
            continue;
        }

        throw new RangeResolveError(`unexpected character "${ch}" at position ${i}`);
    }

    return tokens;
}

/**
 * Recursive-descent parser for the arithmetic grammar. Operates only on the
 * token stream; never evaluates raw text.
 * @private
 */
class _ExpressionParser {
    /**
     * @param {Array<{type: string, value: number|string}>} tokens
     * @param {Object} statMap
     */
    constructor(tokens, statMap) {
        this.tokens = tokens;
        this.pos = 0;
        this.statMap = statMap;
    }

    /** @private */
    _peek() {
        return this.tokens[this.pos];
    }

    /** @private */
    _next() {
        return this.tokens[this.pos++];
    }

    /**
     * Parses the full expression and ensures the entire token stream was consumed.
     * @returns {number}
     * @throws {RangeResolveError} On trailing tokens or any grammar violation.
     * @private
     */
    parse() {
        const value = this._parseExpression();
        if (this.pos !== this.tokens.length) {
            const remaining = this.tokens[this.pos];
            throw new RangeResolveError(`unexpected trailing token "${remaining ? remaining.value : 'end'}"`);
        }
        return value;
    }

    /** expr := term (('+' | '-') term)* @private */
    _parseExpression() {
        let value = this._parseTerm();
        for (;;) {
            const token = this._peek();
            if (token && (token.type === '+' || token.type === '-')) {
                this._next();
                const rhs = this._parseTerm();
                value = token.type === '+' ? value + rhs : value - rhs;
            } else {
                break;
            }
        }
        return value;
    }

    /** term := factor (('*' | '/') factor)* @private */
    _parseTerm() {
        let value = this._parseFactor();
        for (;;) {
            const token = this._peek();
            if (token && (token.type === '*' || token.type === '/')) {
                this._next();
                const rhs = this._parseFactor();
                if (token.type === '/') {
                    if (rhs === 0) {
                        throw new RangeResolveError('division by zero');
                    }
                    value = value / rhs;
                } else {
                    value = value * rhs;
                }
            } else {
                break;
            }
        }
        return value;
    }

    /** factor := ('+' | '-') factor | primary @private */
    _parseFactor() {
        const token = this._peek();
        if (token && token.type === '+') {
            this._next();
            return this._parseFactor();
        }
        if (token && token.type === '-') {
            this._next();
            return -this._parseFactor();
        }
        return this._parsePrimary();
    }

    /** primary := number | ':placeholder' | '(' expr ')' @private */
    _parsePrimary() {
        const token = this._peek();
        if (!token) {
            throw new RangeResolveError('unexpected end of expression');
        }

        if (token.type === 'number') {
            this._next();
            return token.value;
        }

        if (token.type === ':placeholder') {
            this._next();
            const name = token.value;
            const value = this.statMap[name];
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                // Unknown / non-numeric placeholder: abort the whole expression so
                // resolveRange returns the caller's fallback (never 0).
                throw new RangeResolveError(`unknown placeholder ":${name}"`);
            }
            return value;
        }

        if (token.type === '(') {
            this._next();
            const value = this._parseExpression();
            const closing = this._peek();
            if (!closing || closing.type !== ')') {
                throw new RangeResolveError('missing closing parenthesis');
            }
            this._next();
            return value;
        }

        throw new RangeResolveError(`unexpected token "${token.value}"`);
    }
}

export { RangeResolveError };
