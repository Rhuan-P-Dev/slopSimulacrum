/**
 * AgentBodyController — unit tests (the "Create Agent Body" dev feature,
 * Feature A).
 *
 * The LLM seam is faked (TST-2 — the real provider is covered by the live
 * smoke test, not by these unit tests). Card PNGs are written to the real
 * data/cards/ directory (gitignored) by the test fixture and removed on
 * teardown; no committed card is touched.
 *
 * @module test/unit/AgentBodyController
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import path from 'node:path';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import ComponentStatsController from '../../src/controllers/core/componentStatsController.js';
import TraitsController from '../../src/controllers/traits/TraitsController.js';
import ComponentController from '../../src/controllers/core/componentController.js';
import EntityController from '../../src/controllers/core/entityController.js';
import AgentBodyController, {
    CardNotFoundError,
    DesignValidationError,
    PROMPT_KIND,
    PROMPT_VERSION,
    LLM_AGENT_BODY_MAX_TOKENS
} from '../../src/controllers/networking/AgentBodyController.js';
import { LLMError } from '../../src/utils/CustomErrors.js';
import { LLM_DEFAULT_TEMPERATURE } from '../../src/utils/Constants.js';

const CARDS_DIR = path.resolve('data/cards');
const MINAKO_STEM = 'minako';
const QUIET_STEM = 'quiet';
let originalLlmModel;

/**
 * Minimal PNG chunk emitter (same framing as the reader tests; the reader
 * does not validate CRCs, so the CRC bytes are zero).
 */
function pngChunk(type, payload) {
    const lengthField = Buffer.alloc(4);
    lengthField.writeUInt32BE(payload.length);
    return Buffer.concat([
        lengthField,
        Buffer.from(type, 'ascii'),
        payload,
        Buffer.from([0, 0, 0, 0])
    ]);
}

/**
 * Framed 1x1 PNG with a `chara` tEXt side channel carrying the base64-encoded
 * card JSON (chara_card_v2 nested shape).
 * @param {Object} cardData - the character payload ({name, description, personality}).
 * @returns {Buffer}
 */
function buildCardPng(cardData) {
    const b64 = Buffer.from(JSON.stringify({
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: cardData
    }), 'utf8').toString('base64');
    const tEXtPayload = Buffer.concat([
        Buffer.from('chara', 'ascii'),
        Buffer.from([0x00]),
        Buffer.from(b64, 'utf8')
    ]);
    const ihdrData = Buffer.from([
        0x00, 0x00, 0x00, 0x01,
        0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00
    ]);
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', ihdrData),
        pngChunk('tEXt', tEXtPayload),
        pngChunk('IDAT', Buffer.from([0x78, 0x01])),
        pngChunk('IEND', Buffer.from([]))
    ]);
}

/**
 * A design object that passes every validation rule (all structure components
 * exist in the catalog; one new recipe with valid fractions and a valid organ).
 */
const HAPPY_BODY = {
    blueprintId: 'minakoRunner',
    rationale: 'A slim iron frame with light legs fits Minako, an errand runner: fast enough for the back alleys, sturdy enough to carry parcels. A single think core keeps the mind quiet enough to watch the route.',
    structure: {
        component: 'm1CentralBody',
        slot: null,
        children: [
            { component: 'm1Head', slot: null, children: [] },
            {
                component: 'm1Leg',
                slot: 'frontal_left',
                children: [{ component: 'm1Toe', slot: 'left', children: [] }]
            },
            { component: 'm1Leg', slot: 'frontal_right', children: [] },
            { component: 'm1Toe', slot: 'back', children: [] }
        ]
    },
    components: [
        {
            name: 'parcelStrap',
            form: { volume: 3, position: { x: 2, y: 1 } },
            materials: [
                { material: 'iron', fraction: 0.6 },
                { material: 'wood', fraction: 0.4 }
            ],
            internalComponents: ['thinkCore'],
            energyCapacity: 10
        }
    ]
};

function makeFakeLlmController() {
    const chatFull = vi.fn();
    return { chatFull };
}

/**
 * Awaits a promise and returns the error it rejects with, asserting that it
 * rejects. In this vitest/chai version `await expect(p).rejects.toThrow()`
 * resolves to the Assertion, not the thrown error, so this is how we inspect
 * the thrown error's class / code / errors array.
 * @param {Promise} promise - a promise that is expected to reject.
 * @returns {Promise<Error>} the thrown error.
 */
async function awaitThrown(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error('expected promise to reject');
}

describe('AgentBodyController', () => {
    let controller;
    let fakeLlm;

    beforeAll(async () => {
        await fs.mkdir(CARDS_DIR, { recursive: true });
        // Full-metadata card (happy path).
        await fs.writeFile(
            path.join(CARDS_DIR, MINAKO_STEM + '.png'),
            buildCardPng({
                name: 'Minako',
                description: 'A small fox-like courier droid that runs jobs across the town. Likes the smell of coal and hates the rain.',
                personality: 'Helpful but clumsy. Asks for permission before moving other things.'
            })
        );
        // Minimal card (name only) — exercises the empty description/personality
        // fallbacks in the user prompt and in the card list.
        await fs.writeFile(
            path.join(CARDS_DIR, QUIET_STEM + '.png'),
            buildCardPng({ name: 'Quiet' })
        );
        // Deterministic provider: the controller is tested through the seam,
        // not through the real endpoint. The model id is read from the env at
        // request time, so we pin it for the duration of the suite.
        originalLlmModel = process.env.LLM_MODEL;
        process.env.LLM_MODEL = 'test-model';
        fakeLlm = makeFakeLlmController();
        controller = new AgentBodyController({ llmController: fakeLlm });
    });

    afterAll(async () => {
        for (const stem of [MINAKO_STEM, QUIET_STEM]) {
            await fs.rm(path.join(CARDS_DIR, stem + '.png'), { force: true });
        }
        // Restore the env so the suite leaves the world as it found it.
        if (originalLlmModel === undefined) {
            delete process.env.LLM_MODEL;
        } else {
            process.env.LLM_MODEL = originalLlmModel;
        }
        // Leave the directory (it may hold the operator's real cards); only
        // remove what this suite wrote.
    });

    // ================================================================ listCards
    describe('listCards', () => {
        it('surfaces name, description and personality from the embedded payload', async () => {
            const cards = controller.listCards();
            const minako = cards.find((c) => c.cardId === MINAKO_STEM);
            expect(cards).toContainEqual(
                expect.objectContaining({ cardId: MINAKO_STEM, name: 'Minako' })
            );
            expect(minako).toMatchObject({
                cardId: MINAKO_STEM,
                name: 'Minako',
                description: 'A small fox-like courier droid that runs jobs across the town. Likes the smell of coal and hates the rain.',
                personality: 'Helpful but clumsy. Asks for permission before moving other things.'
            });
        });

        it('falls back to the card stem for name and empties for missing fields', async () => {
            const cards = controller.listCards();
            const quiet = cards.find((c) => c.cardId === QUIET_STEM);
            expect(quiet).toMatchObject({
                cardId: QUIET_STEM,
                name: 'Quiet',
                description: '',
                personality: ''
            });
        });
    });

    // ============================================================= designBody
    describe('designBody', () => {
        it('returns a validated design with the prompt captured in meta (happy path)', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify(HAPPY_BODY),
                finishReason: 'stop'
            });
            const result = await controller.designBody(MINAKO_STEM);

            expect(result.card).toEqual({
                cardId: MINAKO_STEM,
                name: 'Minako',
                description: 'A small fox-like courier droid that runs jobs across the town. Likes the smell of coal and hates the rain.',
                personality: 'Helpful but clumsy. Asks for permission before moving other things.'
            });
            expect(result.body.blueprintId).toBe('Minako');
            expect(result.body.rationale).toBeDefined();
            expect(Object.isFrozen(result.body)).toBe(true);
            expect(Object.isFrozen(result.body.structure)).toBe(true);
            expect(result.body.structure.component).toBe('m1CentralBody');
            expect(result.body.structure.children).toHaveLength(4);
            expect(result.body.structure.children[0].component).toBe('m1Head');
            expect(result.body.structure.children[1].slot).toBe('frontal_left');
            expect(result.body.components).toHaveLength(1);
            expect(result.body.components[0].name).toBe('parcelStrap');
            expect(result.body.components[0].materials).toEqual([
                { material: 'iron', fraction: 0.6 },
                { material: 'wood', fraction: 0.4 }
            ]);

            expect(result.meta.promptKind).toBe(PROMPT_KIND);
            expect(result.meta.promptVersion).toBe(PROMPT_VERSION);
            expect(result.meta.model).toBe('test-model');
            expect(result.meta.finishReason).toBe('stop');
            expect(result.meta.latencyMs).toBeGreaterThanOrEqual(0);
            const [messages, options] = fakeLlm.chatFull.mock.calls[0];
            expect(messages).toHaveLength(2);
            expect(messages[0].role).toBe('system');
            expect(messages[1].role).toBe('user');
            // Prompt kind is named and versioned in the prompt itself (RP-2).
            expect(messages[0].content).toContain('ANATOMY FACTS');
            expect(messages[0].content).toContain('AVAILABLE COMPONENTS');
            expect(messages[0].content).toContain('m1CentralBody');
            expect(messages[1].content).toContain('Minako');
            expect(options.temperature).toBe(LLM_DEFAULT_TEMPERATURE);
            expect(options.max_tokens).toBe(LLM_AGENT_BODY_MAX_TOKENS);
        });

        it('accepts the model output wrapped in a markdown code fence', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: '```json\n' + JSON.stringify(HAPPY_BODY) + '\n```',
                finishReason: 'complete'
            });
            const result = await controller.designBody(MINAKO_STEM);
            expect(result.body.blueprintId).toBe('Minako');
        });

        it('uses the card stem as fallback identity when the card has no metadata', async () => {
            const minimalBody = {
                blueprintId: 'quietWalker',
                rationale: 'A modest body for a quiet character: nothing loud, nothing heavy.',
                structure: { component: 'm1Head', slot: null, children: [] }
            };
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify(minimalBody),
                finishReason: 'stop'
            });
            const result = await controller.designBody(QUIET_STEM);
            expect(result.card).toMatchObject({
                cardId: QUIET_STEM,
                name: 'Quiet',
                description: '',
                personality: ''
            });
            // The most recent call is the one for this card; its prompt must
            // note the missing fields so the model does not hallucinate a
            // description.
            const lastMessages = fakeLlm.chatFull.mock.calls.at(-1)[0];
            expect(lastMessages[1].content).toContain(
                'base the design on the name alone'
            );
        });

        it('keeps what a mount declared about itself, and says nothing for a mount that did not', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.structure.children[1].hidesWithParent = true;
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });

            const result = await controller.designBody(MINAKO_STEM);

            const marked = result.body.structure.children[1];
            expect(marked.component).toBe('m1Leg');
            expect(marked.hidesWithParent, 'the mark rides on the node the client and the writer both read')
                .toBe(true);
            // Absent, not false: a live instance carries the mark or nothing at all
            // (`entityController.createEntityFromBlueprint`), and a written `false`
            // is a second claim about a joint the data answers by silence.
            expect('hidesWithParent' in result.body.structure.children[0]).toBe(false);
            expect(result.body.structure.hidesWithParent, 'the root authored nothing either').toBeUndefined();
        });

        it('rejects a mount mark that is not a boolean', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.structure.children[1].hidesWithParent = 'yes';
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });

            const error = await awaitThrown(controller.designBody(MINAKO_STEM));

            expect(error).toBeInstanceOf(DesignValidationError);
            expect(error.errors.join(' ')).toMatch(/hidesWithParent/);
        });

        it('says in the prompt what the mark means and where it belongs', async () => {
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(HAPPY_BODY), finishReason: 'stop' });
            await controller.designBody(MINAKO_STEM);

            const system = fakeLlm.chatFull.mock.calls.at(-1)[0][0].content;
            expect(system).toContain('"hidesWithParent"');
            expect(system, 'the model is told what the mark does to the prose')
                .toMatch(/behind whatever covers/i);
        });

        it('rejects with CARD_NOT_FOUND when no card PNG matches', async () => {
            const err = await awaitThrown(controller.designBody('no-such-card'));
            expect(err).toBeInstanceOf(CardNotFoundError);
            expect(err.code).toBe('CARD_NOT_FOUND');
            expect(err.cardId).toBe('no-such-card');
            expect(err.message).toContain('no-such-card');
        });

        it('rejects with BODY_DESIGN_INVALID for malformed cardId (defensive)', async () => {
            await expect(controller.designBody('')).rejects.toThrow(/cardId must be a string/);
            await expect(controller.designBody(null)).rejects.toThrow(/cardId must be a string/);
        });

        // ---- model-output validation failures ----
        it('rejects when the model output is not a JSON object', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: 'sorry, i cannot build bodies',
                finishReason: 'stop'
            });
            const err = await awaitThrown(controller.designBody(MINAKO_STEM));
            expect(err).toBeInstanceOf(DesignValidationError);
            expect(err.code).toBe('BODY_DESIGN_INVALID');
            expect(err.errors).toContain('the design was not a JSON object');
            expect(err.message).toContain('card "minako"');
        });

        it('rejects when the model output is a JSON array', async () => {
            fakeLlm.chatFull.mockResolvedValue({ content: '[1, 2, 3]', finishReason: 'stop' });
            await expect(controller.designBody(MINAKO_STEM)).rejects.toThrow();
        });

        it('rejects component nodes that are not available or proposed', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify({
                    blueprintId: 'wingRunner',
                    rationale: 'wings for flight.',
                    structure: { component: 'wingBlade', slot: null, children: [] }
                }),
                finishReason: 'stop'
            });
            const err = await awaitThrown(controller.designBody(MINAKO_STEM));
            expect(err.errors.some((e) => e.includes('unknown component(s) in the body tree: wingBlade'))).toBe(true);
        });

        it('rejects a new recipe whose material fractions do not sum to 1.0', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify({
                    blueprintId: 'strayStrap',
                    rationale: 'one strap for one thing.',
                    structure: { component: 'm1Head', slot: null, children: [] },
                    components: [
                        {
                            name: 'badStrap',
                            form: { volume: 3, position: { x: 1, y: 1 } },
                            materials: [
                                { material: 'iron', fraction: 0.5 },
                                { material: 'wood', fraction: 0.2 }
                            ]
                        }
                    ]
                }),
                finishReason: 'stop'
            });
            const err = await awaitThrown(controller.designBody(MINAKO_STEM));
            expect(err.errors.some((e) => e.includes('must sum to 1.0'))).toBe(true);
        });

        it('rejects organs that are not available', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify({
                    blueprintId: 'teleporter',
                    rationale: 'instant transport.',
                    structure: { component: 'm1Head', slot: null, children: [] },
                    components: [
                        {
                            name: 'teleportCore',
                            form: { volume: 4, position: { x: 0, y: 0 } },
                            materials: [{ material: 'coal', fraction: 1 }],
                            internalComponents: ['teleportOrb']
                        }
                    ]
                }),
                finishReason: 'stop'
            });
            const err = await awaitThrown(controller.designBody(MINAKO_STEM));
            expect(err.errors.some((e) => e.includes('teleportOrb'))).toBe(true);
        });

        it('rejects a missing or empty rationale', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify({
                    blueprintId: 'noRationale',
                    structure: { component: 'm1Head', slot: null, children: [] }
                }),
                finishReason: 'stop'
            });
            const err = await awaitThrown(controller.designBody(MINAKO_STEM));
            expect(err.errors.some((e) => e.includes('"rationale" must be a non-empty string'))).toBe(true);
        });

        it('ignores the model blueprintId and names the body after the card (a model-chosen colliding id is discarded)', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify({
                    blueprintId: 'm1Droid',
                    rationale: 'a rehash.',
                    structure: { component: 'm1Head', slot: null, children: [] }
                }),
                finishReason: 'stop'
            });
            // The model chose 'm1Droid' (an existing blueprint). That id is NOT
            // used — designBody replaces it with the card display name ('Minako'),
            // so there is no collision with the existing 'm1Droid' blueprint.
            const result = await controller.designBody(MINAKO_STEM);
            expect(result.body.blueprintId).toBe('Minako');
        });

        it('rejects trees with more than the node cap', async () => {
            const leaves = Array.from({ length: 17 }).map(() => ({
                component: 'm1Head', slot: null, children: []
            }));
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify({
                    blueprintId: 'bigBody',
                    rationale: 'a crowd.',
                    structure: {
                        component: 'm1Head',
                        slot: null,
                        children: leaves
                    }
                }),
                finishReason: 'stop'
            });
            const err = await awaitThrown(controller.designBody(MINAKO_STEM));
            expect(err.errors.some((e) => e.includes('18 nodes'))).toBe(true);
        });

        it('rejects non-string body slots', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify({
                    blueprintId: 'slotBug',
                    rationale: 'slot as a number is nonsense.',
                    structure: {
                        component: 'm1Leg',
                        slot: 5,
                        children: []
                    }
                }),
                finishReason: 'stop'
            });
            const err = await awaitThrown(controller.designBody(MINAKO_STEM));
            expect(err.errors.some((e) => e.includes('body-tree slot must be null or a non-empty string'))).toBe(true);
        });

        it('rejects when a new recipe name collides with an existing component', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify({
                    blueprintId: 'reuseBug',
                    rationale: 'stealing a name.',
                    structure: { component: 'm1Head', slot: null, children: [] },
                    components: [
                        {
                            name: 'm1Head',
                            form: { volume: 3, position: { x: 1, y: 1 } },
                            materials: [{ material: 'iron', fraction: 1 }]
                        }
                    ]
                }),
                finishReason: 'stop'
            });
            const err = await awaitThrown(controller.designBody(MINAKO_STEM));
            expect(err.errors.some((e) => e.includes('collides with an existing or previously proposed component'))).toBe(true);
        });

        it('propagates LLMError through unchanged (timeout class)', async () => {
            fakeLlm.chatFull.mockRejectedValueOnce(
                new LLMError('LLM request timed out after 3000000ms', 'LLM_TIMEOUT')
            );
            const err = await awaitThrown(controller.designBody(MINAKO_STEM));
            expect(err).toBeInstanceOf(LLMError);
            expect(err.code).toBe('LLM_TIMEOUT');
            // The seam error must pass through untouched (no masking).
            expect(err.message).toBe('LLM request timed out after 3000000ms');
        });
    });

    describe('saveDesign (the "Save" action — persists a validated design)', () => {
        const SAVE_BLUEPRINTS_FILE = 'data/mods/core-blueprints/blueprints.json';
        const SAVE_COMPONENTS_FILE = 'data/mods/core-components/components.json';

        // Every saveDesign here runs against a disposable scratch copy of the world
        // data, so the committed data files are never written to by the suite.
        // saveDesign persists through DataLoader's static save/copy/load seam;
        // those are patched here to route the two data files into the scratch dir
        // (the backups land there too). The scratch copy is seeded from the current
        // real data on each test.
        let scratchDir = '';
        let scratchBlueprints = '';
        let scratchComponents = '';
        let loadSpy = null;
        let saveSpy = null;
        let copySpy = null;

        function seedScratch() {
            scratchDir = fsSync.mkdtempSync(path.join(process.cwd(), 'data', 'scratch-save-design-'));
            scratchBlueprints = path.join(scratchDir, 'blueprints.json');
            scratchComponents = path.join(scratchDir, 'components.json');
            fsSync.mkdirSync(scratchDir, { recursive: true });
            fsSync.copyFileSync(path.resolve(SAVE_BLUEPRINTS_FILE), scratchBlueprints);
            fsSync.copyFileSync(path.resolve(SAVE_COMPONENTS_FILE), scratchComponents);
            const realLoad = DataLoader.loadJsonSafe.bind(DataLoader);
            const realSave = DataLoader.saveJson.bind(DataLoader);
            const realCopy = DataLoader.copyFile.bind(DataLoader);
            loadSpy = vi.spyOn(DataLoader, 'loadJsonSafe').mockImplementation((rel, fallback) => {
                if (rel === SAVE_COMPONENTS_FILE) return JSON.parse(fsSync.readFileSync(scratchComponents, 'utf8'));
                if (rel === SAVE_BLUEPRINTS_FILE) return JSON.parse(fsSync.readFileSync(scratchBlueprints, 'utf8'));
                return realLoad(rel, fallback);
            });
            saveSpy = vi.spyOn(DataLoader, 'saveJson').mockImplementation((rel, data) => {
                const json = JSON.stringify(data, null, 2) + '\n';
                if (rel === SAVE_COMPONENTS_FILE) {
                    fsSync.writeFileSync(scratchComponents, json, 'utf8');
                    return undefined;
                }
                if (rel === SAVE_BLUEPRINTS_FILE) {
                    fsSync.writeFileSync(scratchBlueprints, json, 'utf8');
                    return undefined;
                }
                return realSave(rel, data);
            });
            copySpy = vi.spyOn(DataLoader, 'copyFile').mockImplementation((from, to) => {
                const destName = path.basename(to);
                if (from === SAVE_COMPONENTS_FILE) {
                    fsSync.copyFileSync(scratchComponents, path.join(scratchDir, destName));
                    return to;
                }
                if (from === SAVE_BLUEPRINTS_FILE) {
                    fsSync.copyFileSync(scratchBlueprints, path.join(scratchDir, destName));
                    return to;
                }
                return realCopy(from, to);
            });
        }

        function cleanupScratch() {
            if (loadSpy) { loadSpy.mockRestore(); loadSpy = null; }
            if (saveSpy) { saveSpy.mockRestore(); saveSpy = null; }
            if (copySpy) { copySpy.mockRestore(); copySpy = null; }
            if (scratchDir) {
                fsSync.rmSync(scratchDir, { recursive: true, force: true });
                scratchDir = '';
                scratchBlueprints = '';
                scratchComponents = '';
            }
        }

        function readScratchBlueprints() {
            return JSON.parse(fsSync.readFileSync(scratchBlueprints, 'utf8'));
        }
        function readScratchComponents() {
            return JSON.parse(fsSync.readFileSync(scratchComponents, 'utf8'));
        }

        it('writes a brand-new droid key + a new component into the world files and takes pre-write backups', async () => {
            seedScratch();
            try {
                const result = await controller.saveDesign(HAPPY_BODY);
                expect(result.saved).toBe(true);
                expect(result.blueprintId).toBe('minakoRunner');
                expect(result.newComponents).toEqual(['parcelStrap']);
                expect(result.blueprintWritten).toEqual(
                    expect.arrayContaining(['minakoRunner', 'm1CentralBody', 'm1Leg'])
                );
                // minakoRunner is new; m1CentralBody + m1Leg already existed -> overwritten.
                expect(result.blueprintOverwritten).toEqual(
                    expect.arrayContaining(['m1CentralBody', 'm1Leg'])
                );
                expect(result.blueprintOverwritten).not.toContain('minakoRunner');
                expect(typeof result.backups.blueprints).toBe('string');
                expect(typeof result.backups.components).toBe('string');

                const bl = readScratchBlueprints();
                expect(bl.minakoRunner).toEqual(['m1CentralBody']);
                expect(bl.m1CentralBody).toEqual([
                    'm1Head',
                    ['m1Leg', 'frontal_left'],
                    ['m1Leg', 'frontal_right'],
                    ['m1Toe', 'back']
                ]);
                expect(bl.m1Leg).toEqual([['m1Toe', 'left']]);

                const cm = readScratchComponents();
                expect(cm.parcelStrap).toEqual({
                    name: 'parcelStrap',
                    form: { volume: 3, position: { x: 2, y: 1 } },
                    materials: [
                        { material: 'iron', fraction: 0.6 },
                        { material: 'wood', fraction: 0.4 }
                    ],
                    internalComponents: ['thinkCore'],
                    energyCapacity: 10
                });

                // A pre-write backup of each touched file was created (timestamped
                // sibling) in the scratch dir.
                const scratchFiles = fsSync.readdirSync(scratchDir);
                expect(scratchFiles.some((f) => /blueprints\.json\.bak-\d+/.test(f))).toBe(true);
                expect(scratchFiles.some((f) => /components\.json\.bak-\d+/.test(f))).toBe(true);
            } finally {
                cleanupScratch();
            }
        });

        it('writes a mount mark as the third element of the mount, in the shape the world reads', async () => {
            const design = structuredClone(HAPPY_BODY);
            // One marked mount with a slot, one without. The slotless one is the
            // interesting case: the mark is the THIRD element of the mount, so a
            // marked joint with no slot has to say the identifier `expandBlueprint`
            // itself would have given it - never invent a body position to carry a mark.
            design.structure.children[0].hidesWithParent = true;  // m1Head, no slot
            design.structure.children[3].hidesWithParent = true;  // m1Toe, 'back'
            seedScratch();
            try {
                await controller.saveDesign(design);

                const bl = readScratchBlueprints();
                expect(bl.m1CentralBody).toEqual([
                    ['m1Head', 'default', { hidesWithParent: true }],
                    ['m1Leg', 'frontal_left'],
                    ['m1Leg', 'frontal_right'],
                    ['m1Toe', 'back', { hidesWithParent: true }]
                ]);

                // The shape the design WRITES is the shape the live world READS:
                // instantiate the saved blueprint with the real EntityController,
                // over the saved file - not over a row this test typed by hand.
                const spawned = new EntityController(
                    new ComponentController(
                        new ComponentStatsController(),
                        new TraitsController({}),
                        DataLoader.loadRegistry(REGISTRY_KINDS.COMPONENTS)
                    ),
                    bl
                ).createEntityFromBlueprint('minakoRunner');
                expect(spawned.components.filter((c) => c.hidesWithParent === true).map((c) => c.type).sort())
                    .toEqual(['m1Head', 'm1Toe']);
            } finally {
                cleanupScratch();
            }
        });

        it('rejects a blueprintId that is a sub-tree part (droid type must be a distinct key)', async () => {
            const design = {
                blueprintId: 'm1CentralBody',
                rationale: 'Reuse the part name as the droid type (must be rejected).',
                structure: {
                    component: 'm1CentralBody',
                    slot: null,
                    children: [{ component: 'm1Head', slot: null, children: [] }]
                },
                components: []
            };
            seedScratch();
            let error;
            try {
                await controller.saveDesign(design);
            } catch (e) {
                error = e;
            } finally {
                cleanupScratch();
            }
            expect(error).toBeInstanceOf(DesignValidationError);
            expect(error.errors[0]).toContain('must not be the name of any component used in the body tree');
        });

        it('rejects a design referencing a component that is neither in the catalog nor proposed', async () => {
            const design = {
                blueprintId: 'ghostDroid',
                rationale: 'Uses a part that does not exist in the catalog.',
                structure: {
                    component: 'm1CentralBody',
                    slot: null,
                    children: [{ component: 'ghostComponent', slot: null, children: [] }]
                },
                components: []
            };
            seedScratch();
            let error;
            try {
                await controller.saveDesign(design);
            } catch (e) {
                error = e;
            } finally {
                cleanupScratch();
            }
            expect(error).toBeInstanceOf(DesignValidationError);
            expect(error.message).toMatch(/unknown component/);
        });
    });
});
