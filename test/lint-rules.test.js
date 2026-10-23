/**
 * test/lint-rules.test.js — pins the CR rules (tools/eslint-rules.js) to their
 * fixtures.
 *
 * Why this file exists: CODE_RULES.md's ENFORCEMENT section says "rules are
 * pinned to fixtures". This is the pin. Each fixture in
 * src/lint-fixtures/ carries exactly one rule violation (or zero, for the
 * clean fixture). This suite runs the REPO'S ACTUAL eslint.config.js against
 * each fixture and asserts the rule ids that fire.
 *
 * Contract:
 *   - Each fixture produces EXACTLY the rule ids it is named for.
 *   - The clean fixture produces no messages.
 *   - The gate lint (npm run lint) excludes src/lint-fixtures/** via
 *     --ignore-pattern, so these counter-examples do not block green commits;
 *     the fixture files are not application source.
 *   - Adding/tightening a CR rule MUST add (or tighten) a fixture AND an
 *     entry in FIXTURE_RULES. Dropping a fixture loosens a rule.
 */
import * as path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { ESLint } from 'eslint';

// Fixture path (relative to repo root) -> rule ids that MUST fire (exact set).
// clean.fixture.js is intentionally empty: zero messages.
const FIXTURE_RULES = {
    'src/lint-fixtures/accented-text.fixture.js': ['cr/no-accented-text'],
    'src/lint-fixtures/console-in-server.fixture.js': ['no-console'],
    'src/lint-fixtures/direct-file-read.fixture.js': ['cr/no-direct-file-read'],
    'src/lint-fixtures/fetch-no-signal.fixture.js': ['cr/fetch-requires-signal'],
    'src/lint-fixtures/clean.fixture.js': [],
};

const repoRoot = path.resolve(__dirname, '..');
const eslintConfigPath = path.resolve(repoRoot, 'eslint.config.js');

/** Single ESLint instance for the whole suite (flat-config lint is cheap). */
let eslint;
beforeAll(() => {
    eslint = new ESLint({
        cwd: repoRoot,
        overrideConfigFile: eslintConfigPath,
    });
});

async function ruleIds(relPath) {
    const results = await eslint.lintFiles([path.resolve(repoRoot, relPath)]);
    return (results[0].messages || []).map((m) => m.ruleId);
}

describe('CR rules — fixture pinning (CODE_RULES.md -> Enforcement)', () => {
    for (const [rel, expected] of Object.entries(FIXTURE_RULES)) {
        it(`fires exactly ${JSON.stringify(expected)} on ${path.basename(rel)}`, async () => {
            const got = (await ruleIds(rel)).sort();
            expect(got).toEqual(expected.slice().sort());
        });
    }
});
