/**
 * tools/eslint-rules.js — cr/* — the CODE_RULES.md quality bar as ESLint rules.
 *
 * This is a LOCAL plugin: no npm dependency, plain ESM, lint-only. It is
 * never required by the app. It lives next to eslint.config.js and exports
 * a single default object in the flat-config plugin shape:
 *   { meta: { name, version }, rules: { [ruleId]: { meta, schema, create } } }
 *
 * Rules (IDs from CODE_RULES.md):
 *
 *   cr/fetch-requires-signal  — every fetch() must carry an AbortSignal.  (CR E-5)
 *   cr/no-direct-file-read    — no `fs` imports outside the data seam.      (CR B-3)
 *   cr/no-accented-text       — no accented Latin letters in code.         (CR NAME-1)
 *
 * Change protocol (CODE_RULES.md -> Enforcement):
 *   a new or tightened rule gets a fixture FIRST (src/lint-fixtures/), then
 *   the rule itself, then its scope block in eslint.config.js - one commit.
 *   If a rule stops firing on its fixture, that commit is broken.
 */

import * as path from 'node:path';

/* ---------------------------------------------------------------- fs ---- */

/** fs-family module specifiers, optionally `node:` prefixed. */
const FS_SPEC_RE = /^(?:node:)?(?:fs\/promises|fs)$/i;

/**
 * Files that MAY import fs. This is the data seam from CR B-3. Kept as a
 * constant (and re-settable via rule options) so the seam is visible at one
 * place in the lint code.
 */
const DEFAULT_ALLOWED_FS_FILES = [
    'src/utils/DataLoader.js',
    'src/utils/PngCharaReader.js',
    'src/controllers/logic/CardSpawnLogic.js',
];

const crNoDirectFileRead = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Only the data seam may touch the filesystem. Any other module ' +
                'importing `fs` bypasses the DataLoader seam and violates CR B-3.',
        },
        schema: [
            {
                type: 'object',
                properties: {
                    /**
                     * Relative-to-cwd paths that MAY import fs. Defaults to the
                     * data seam; the eslint.config.js block overrides it.
                     */
                    allowedFiles: {
                        type: 'array',
                        items: { type: 'string' },
                    },
                },
                additionalProperties: false,
            },
        ],
    },
    create(context) {
        const options = context.options || {};
        const allowedFiles = Array.isArray(options.allowedFiles)
            ? options.allowedFiles
            : DEFAULT_ALLOWED_FS_FILES;
        const allowed = new Set(allowedFiles);

        const isAllowedFile = (absPath) =>
            allowed.has(path.relative(context.cwd, absPath));

        return {
            ImportDeclaration(node) {
                // The module specifier lives on `node.source` (string, template
                // literal, or member expression). Side-effect imports (`import
                // './x'`) also have a source; that is what we are policing here.
                const source = node.source?.value;
                if (typeof source !== 'string' || !FS_SPEC_RE.test(source)) {
                    return;
                }
                if (isAllowedFile(context.filename)) {
                    return;
                }
                context.report({
                    node,
                    message:
                        `Direct filesystem access violates CR B-3 (data seam only): ` +
                        `"${source}" may only be imported from ` +
                        `${allowedFiles.join(', ')}. Read through the DataLoader seam.`,
                });
            },
        };
    },
};

/* ---------------------------------------------------------------- fetch -- */

const GLOBAL_SCOPE_NAMES = new Set(['globalThis', 'window', 'self']);

const isFetchCall = (node) => {
    const { callee } = node;
    if (callee.type === 'Identifier' && callee.name === 'fetch') {
        return true;
    }
    if (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'fetch'
    ) {
        const obj = callee.object;
        if (obj.type === 'ThisExpression') {
            return true;
        }
        if (obj.type === 'Identifier' && GLOBAL_SCOPE_NAMES.has(obj.name)) {
            return true;
        }
    }
    return false;
};

const crFetchRequiresSignal = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Every fetch() needs an AbortSignal so a stall or a bad turn ' +
                'cannot hang a socket or a turn. (CR E-5; LLMController is the ' +
                'reference implementation.)',
        },
    },

    create(context) {
        return {
            CallExpression(node) {
                if (!isFetchCall(node)) {
                    return;
                }
                const args = node.arguments;
                // No second argument at all.
                if (args.length === 0) {
                    context.report({
                        node,
                        message:
                            'fetch() has no AbortSignal (CR E-5). Pass `signal: ' +
                            'controller.signal` or `AbortSignal.timeout(ms)`.',
                    });
                    return;
                }
                const opts = args[1];
const hasSignal =
                    opts.type === 'ObjectExpression' &&
                    opts.properties.some((p) => {
                        // Modern ESTree uses `Property` with `key` (the legacy
                        // shape has `ObjectProperty` with `property`). Accept both.
                        const key = p.key || p.property;
                        return key !== undefined &&
                            key.type === 'Identifier' &&
                            key.name === 'signal';
                    });
                if (!hasSignal) {
                    context.report({
                        node,
                        message:
                            'fetch() options have no `signal` (CR E-5). A signal ' +
                            'is mandatory - `AbortSignal.timeout(ms)` is the default ' +
                            'if no caller-controlled controller exists.',
                    });
                }
            },
        };
    },
};

/* -------------------------------------------------------------- accents --- */

/** Accented / extended Latin letters (excludes the symbol U+00D7). */
const ACENTED_LETTERS_RE = /[\u00C0-\u00D6\u00D8-\u017F]/u;

/**
 * Exception tokens. Keep this list tiny and auditable; every token here is
 * a deliberate deviation from CR NAME-1 and must be justified at review.
 */
// Escaped so the lint machinery itself stays accent-free (check:lang scans
// the repo, including this file).
const ALLOWED_TOKENS = ['B\u00e9zier', 'na\u00f9ve'];

const crNoAccentedText = {
    meta: {
        type: 'problem',
        docs: {
            description:
                'Code is English-only: accented or Latin Extended letters are ' +
                'not allowed in source files. (CR NAME-1, also checked repo-wide ' +
                'by check:lang.)',
        },
    },

    create(context) {
        const source = context.sourceCode;

        const lineIsClean = (text) => {
            let remaining = text;
            for (const token of ALLOWED_TOKENS) {
                remaining = remaining.split(token).join(' ');
            }
            return !ACENTED_LETTERS_RE.test(remaining);
        };

        return {
            Program(node) {
                const lines = source.getText().split('\n');
                for (let i = 0; i < lines.length; i += 1) {
                    if (!ACENTED_LETTERS_RE.test(lines[i]) || lineIsClean(lines[i])) {
                        continue;
                    }
                    const match = lines[i].search(ACENTED_LETTERS_RE);
                    const ch = lines[i].charAt(match);
                    context.report({
                        node,
                        location: { line: i + 1, column: match },
                        message:
                            `Accented letter ${JSON.stringify(ch)} is not allowed in code ` +
                            `(CR NAME-1, English-only). Use plain ASCII, or add the exact ` +
                            'token to ALLOWED_TOKENS in tools/eslint-rules.js with a ' +
                            'review justification.',
                    });
                }
            },
        };
    },
};

export default {
    meta: {
        name: 'slop-cr-rules',
        version: '1.0.0',
    },
    rules: {
        // Rule keys here are NOT prefix-prefixed: the plugin name (`cr`) is
        // prepended by flat-config, so the effective rule IDs are the
        // `cr/...` names used throughout eslint.config.js and CODE_RULES.md.
        'fetch-requires-signal': crFetchRequiresSignal,
        'no-direct-file-read': crNoDirectFileRead,
        'no-accented-text': crNoAccentedText,
    },
};
