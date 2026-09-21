/**
 * vocabulary — Assembles the data the editor's UI needs to render pickers,
 * hints, and reference panels.
 *
 * WHY this exists:
 *   The browser cannot import the parent project's modules directly, and it
 *   is cleaner to hand it one plain JSON blob than to wire up a separate
 *   static route for each shared module. This module runs on the server, imports
 *   the *real* shared vocabularies (single source of truth for the string
 *   contracts) and merges the editor's own consequence-type knowledge, then
 *   exposes the result through /api/vocabulary.
 *
 * @module vocabulary
 */

import {
    TARGETING_TYPES,
    BINDING_ROLES,
    TARGET_ANCHORS,
    ACTION_NAMES,
} from '../../shared/ActionVocabulary.js';
import {
    TRAIT_GROUPS,
    STAT_NAMES,
    DAMAGE_CHANNELS,
} from '../../shared/StatVocabulary.js';
import {
    CONSEQUENCE_TYPES,
    CONSEQUENCE_PARAM_SPECS,
    CONSEQUENCE_TARGETS,
    KNOWN_ACTION_PARAMS,
} from './schema.js';

/**
 * A plain object describing how the game executes an action. This is the
 * "read how actions are done" reference the UI surfaces — a human-readable
 * description of the pipeline, plus the static vocabularies the UI picks from.
 */
const EXECUTION_PIPELINE = [
    { step: 1, title: 'Validate requirements', detail: 'Every declared requirement (trait, stat, minValue) must be met by the acting entity\'s components. Equipped-item stats are merged into the check. If any fail, the action fails and failureConsequences run.' },
    { step: 2, title: 'Bind the acting components', detail: 'The engine decides which of the actor\'s components actually perform the action — from an explicit source, the spatially-targeted component, a self-targeted slot, or the whole entity.' },
    { step: 3, title: 'Resolve range', detail: 'For component/spatial actions, the range (a number or a :Trait.stat expression) is resolved against the actor\'s live stats. Unresolvable ranges use a safe fallback.' },
    { step: 4, title: 'Apply synergy', detail: 'If cooperating components are bound to the action, a synergy multiplier from the synergy registry scales numeric consequence values (subject to per-action caps).' },
    { step: 5, title: 'Dispatch consequences', detail: 'Each success consequence is resolved to a concrete target (self/target/entity) and handed to its handler; parameters and range placeholders are resolved to live values first.' },
];

const PIPELINE_NOTE =
    'Failure consequences run through the same pipeline as success consequences; a failure never aborts the round, it just logs and discards the queued action.';

/**
 * A single source of the range grammar, presented for the UI's "reference" panel.
 * Matches the game's RangeResolver recursive-descent parser.
 */
const RANGE_GRAMMAR = {
    rules: [
        { name: 'expr',    desc: "term (('+' | '-') term)*        — left-to-right addition/subtraction" },
        { name: 'term',    desc: "factor (('*' | '/') factor)*    — multiplication/division (÷0 → fallback)" },
        { name: 'factor',  desc: "('+' | '-') factor | primary   — unary sign" },
        { name: 'primary', desc: "number | ':placeholder' | '(' expr ')'" },
    ],
    examples: ['10', ':Physical.strength', ':Physical.strength*2', '-:Physical.mass', ':Physical.strength*2+3', '(2+3)*:Movement.move'],
    rulesNote: 'A ":placeholder" maps to a live Trait.stat or an action param; if any referenced placeholder is missing or non-numeric, the whole expression falls back (never 0).',
};

/**
 * Build the full vocabulary blob for the UI.
 * @returns {Object}
 */
export function buildVocabulary() {
    return {
        // --- Static vocabularies (single source: shared modules) ---
        targetingTypes: Object.values(TARGETING_TYPES).map((v) => [v, v]),
        consequenceTargets: [...CONSEQUENCE_TARGETS],
        traitGroups: Object.values(TRAIT_GROUPS),
        statNames: Object.values(STAT_NAMES),
        damageChannels: Object.values(DAMAGE_CHANNELS),
        bindingRoles: { ...BINDING_ROLES },
        targetAnchors: { ...TARGET_ANCHORS },
        knownActionNames: Object.values(ACTION_NAMES),
        knownActionParams: [...KNOWN_ACTION_PARAMS],

        // --- Editor's consequence-type knowledge ---
        consequenceTypes: [
            ...CONSEQUENCE_TYPES.map((type) => ({
                type,
                params: CONSEQUENCE_PARAM_SPECS[type] ?? { required: [], optional: [], desc: '' },
            })),
        ],

        // --- "How actions execute" reference ---
        pipeline: EXECUTION_PIPELINE,
        pipelineNote: PIPELINE_NOTE,
        rangeGrammar: RANGE_GRAMMAR,

        // Provenance (so the UI can note where the truth comes from).
        sources: {
            actionVocabulary: pathsActionVocabLabel(),
            statVocabulary: 'shared/StatVocabulary.js',
            rangeResolver: 'shared/RangeResolver.js',
            consequenceHandlers: 'src/controllers/consequences/consequenceHandlers.js',
        },
    };
}

/**
 * Label for the ActionVocabulary source shown in the UI.
 * @returns {string}
 */
function pathsActionVocabLabel() {
    return 'shared/ActionVocabulary.js';
}

export default buildVocabulary;
