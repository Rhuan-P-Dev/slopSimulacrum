/**
 * AgentBodyController — unit tests (the "Create Agent Body" dev feature,
 * Feature A). The design runs as a four-stage pipeline (concept -> anatomy
 * -> organs -> outfit, one LLM call each in a fresh context);
 * `AgentBodyDesignPipeline` drives the seam, and these tests queue one answer
 * per stage on it.
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
import path from 'node:path';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';
import ComponentStatsController from '../../src/controllers/core/componentStatsController.js';
import TraitsController from '../../src/controllers/traits/TraitsController.js';
import ComponentController from '../../src/controllers/core/componentController.js';
import EntityController from '../../src/controllers/core/entityController.js';
import AgentBodyController, {
    CardNotFoundError,
    DesignValidationError
} from '../../src/controllers/networking/AgentBodyController.js';
import AgentBodyDesignPipeline, {
    DesignStageError,
    STAGE_ORDER,
    STAGE_PROMPT_KIND,
    STAGE_PROMPT_VERSION,
    LLM_STAGE_MAX_TOKENS
} from '../../src/controllers/networking/AgentBodyDesignPipeline.js';
import { LLMError } from '../../src/utils/CustomErrors.js';
import ModPackageWriter from '../../src/services/ModPackageWriter.js';
import { LLM_DEFAULT_TEMPERATURE } from '../../src/utils/Constants.js';

const CARDS_DIR = path.resolve('data/cards');
const NOVA_STEM = 'nova';
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
 * The anatomy stage's material: a body tree whose components all exist in the
 * catalog, plus one new recipe with valid fractions and a valid world organ.
 * The pipeline's per-stage fixtures are built from it (the concept's rationale
 * is the same text; the designer organs and the clothing come from their own
 * stages, so they are not part of this shape).
 */
const HAPPY_BODY = {
    blueprintId: 'novaRunner',
    rationale: 'A slim iron frame with light legs fits Nova, an errand runner: fast enough for the back alleys, sturdy enough to carry parcels. A single think core keeps the mind quiet enough to watch the route.',
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
            path.join(CARDS_DIR, NOVA_STEM + '.png'),
            buildCardPng({
                name: 'Nova',
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
        for (const stem of [NOVA_STEM, QUIET_STEM]) {
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
            const nova = cards.find((c) => c.cardId === NOVA_STEM);
            expect(cards).toContainEqual(
                expect.objectContaining({ cardId: NOVA_STEM, name: 'Nova' })
            );
            expect(nova).toMatchObject({
                cardId: NOVA_STEM,
                name: 'Nova',
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

    // ================================================================ readCardImage
    describe('readCardImage', () => {
        it('returns the raw file bytes with the content type of the file extension', async () => {
            const expected = await fs.readFile(path.join(CARDS_DIR, NOVA_STEM + '.png'));
            const { bytes, mimeType } = controller.readCardImage(NOVA_STEM);
            expect(bytes.equals(expected)).toBe(true);
            expect(mimeType).toBe('image/png');
        });

        it('throws CardNotFoundError when no card file matches the id', () => {
            let thrown = null;
            try {
                controller.readCardImage('no-such-card');
            } catch (error) {
                thrown = error;
            }
            expect(thrown).toBeInstanceOf(CardNotFoundError);
        });

        it('reads the cards-directory listing once and reuses it for every card (no N+1 dir read)', () => {
            // The Cards screen fetches one image per card; each read matches the
            // id against the on-disk listing. A fresh readdirSync yields a FRESH
            // array, so returning the SAME array reference for two per-card reads
            // is the mechanical proof that _listCardFiles cached the listing and
            // the second read did not re-read the directory (the N+1 this exists
            // to remove). The data-seam readCardFiles import is spied at the
            // controller-method level here (readCardImage -> _listCardFiles),
            // because a module-level vi.mock of the data seam would be
            // over-instrumentation for a dev-tab perf guard.
            const spy = vi.spyOn(controller, '_listCardFiles');
            controller.readCardImage(NOVA_STEM);
            controller.readCardImage(QUIET_STEM);
            expect(spy).toHaveBeenCalledTimes(2);
            // Both reads returned the identical (cached) listing object.
            expect(spy.mock.results[0].value).toBe(spy.mock.results[1].value);
            spy.mockRestore();
        });
    });

    // ============================================================= designBody
    //
    // The design is a FOUR-STAGE PIPELINE: concept -> anatomy -> organs ->
    // outfit, each one LLM call in a fresh context (the stage outputs are the
    // only memory a stage carries). These tests drive it through the seam
    // (TST-2): `chatFull` is queued once per stage, in order.
    describe('designBody', () => {
        /**
         * The concept stage's answer (the seed every later stage reads).
         */
        const NOVA_CONCEPT = {
            rationale: 'A slim iron frame with light legs fits Nova, an errand runner: fast enough for the back alleys, sturdy enough to carry parcels.',
            focus: ['slim iron frame', 'light legs for the alleys', 'a quiet think core']
        };
        /**
         * The anatomy stage's answer: the old single-call HAPPY_BODY's tree and
         * its one invented recipe (the recipe names only a WORLD organ here —
         * the designer organs arrive from the organs stage).
         */
        const NOVA_ANATOMY = {
            structure: HAPPY_BODY.structure,
            components: HAPPY_BODY.components
        };
        /** The organs stage's zero-organ answer (a valid body runs on world organs). */
        const NO_ORGANS = { internalComponents: [] };
        /** The outfit stage's silent answer: the design said nothing about clothing. */
        const NO_OUTFIT = {};

        /**
         * Queue one answer per pipeline stage (in STAGE_ORDER) on the LLM seam
         * stub. A stage value is an object (JSON-stringified for the seam) or
         * a raw content string (fence and garbage cases). `mockReset` first,
         * so a short queue never leaks answers into the next test.
         * @param {import('vitest').Mock} chatFull
         * @param {{ concept?: object|string, anatomy?: object|string, organs?: object|string, outfit?: object|string }} stages
         */
        function queueDesignStages(chatFull, stages = {}) {
            const { concept = NOVA_CONCEPT, anatomy = NOVA_ANATOMY, organs = NO_ORGANS, outfit = NO_OUTFIT } = stages;
            chatFull.mockReset();
            for (const stage of [concept, anatomy, organs, outfit]) {
                chatFull.mockResolvedValueOnce({
                    content: typeof stage === 'string' ? stage : JSON.stringify(stage),
                    finishReason: 'stop'
                });
            }
        }

        /**
         * Queue the stages BEFORE the failing one as one-shot answers, then a
         * PERSISTENT bad answer for the failing stage itself: the stage fails
         * on every attempt, so the pipeline gives it up (DesignStageError)
         * without ever reaching the later stages.
         * @param {import('vitest').Mock} chatFull
         * @param {'concept'|'anatomy'|'organs'|'outfit'} stage - the stage that fails.
         * @param {object|string} bad - that stage's failing answer (repeated per attempt).
         */
        function queueStageFailure(chatFull, stage, bad) {
            chatFull.mockReset();
            const answers = { concept: NOVA_CONCEPT, anatomy: NOVA_ANATOMY, organs: NO_ORGANS, outfit: NO_OUTFIT };
            for (let i = 0; i < STAGE_ORDER.indexOf(stage); i++) {
                chatFull.mockResolvedValueOnce({ content: JSON.stringify(answers[STAGE_ORDER[i]]), finishReason: 'stop' });
            }
            chatFull.mockImplementation(() => Promise.resolve({
                content: typeof bad === 'string' ? bad : JSON.stringify(bad),
                finishReason: 'stop'
            }));
        }

        it('returns a validated design with the per-stage meta (happy path)', async () => {
            queueDesignStages(fakeLlm.chatFull);
            const result = await controller.designBody(NOVA_STEM);

            expect(result.card).toEqual({
                cardId: NOVA_STEM,
                name: 'Nova',
                description: 'A small fox-like courier droid that runs jobs across the town. Likes the smell of coal and hates the rain.',
                personality: 'Helpful but clumsy. Asks for permission before moving other things.'
            });
            // The body takes the card's display name, never a model-chosen id.
            expect(result.body.blueprintId).toBe('Nova');
            expect(result.body.rationale).toBe(NOVA_CONCEPT.rationale);
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

            // The meta is the pipeline's per-stage record: one entry per
            // stage, in order, each naming its kind, version, model, finish
            // reason, latency, attempts and the exact messages it sent.
            expect(result.meta.kind).toBe('agent-body-design-pipeline');
            expect(result.meta.stages).toHaveLength(4);
            expect(result.meta.stages.map((s) => s.step)).toEqual(['concept', 'anatomy', 'organs', 'outfit']);
            for (const [i, stage] of result.meta.stages.entries()) {
                expect(stage.kind).toBe(STAGE_PROMPT_KIND[STAGE_ORDER[i]]);
                expect(stage.version).toBe(STAGE_PROMPT_VERSION[STAGE_ORDER[i]]);
                expect(stage.model).toBe('test-model');
                expect(stage.finishReason).toBe('stop');
                expect(stage.latencyMs).toBeGreaterThanOrEqual(0);
                expect(stage.attempts).toBe(1);
                expect(stage.promptMessages).toHaveLength(2);
                expect(stage.promptMessages[0].role).toBe('system');
                expect(stage.promptMessages[1].role).toBe('user');
            }
            // Four seam calls, one per stage, each within its own token budget.
            const personas = { concept: 'CHARACTER CONCEPTOR', anatomy: 'BODY DESIGNER', organs: 'ANATOMIST', outfit: 'DRESSER' };
            expect(fakeLlm.chatFull).toHaveBeenCalledTimes(4);
            for (const [i, step] of STAGE_ORDER.entries()) {
                const [messages, options] = fakeLlm.chatFull.mock.calls[i];
                expect(options.temperature).toBe(LLM_DEFAULT_TEMPERATURE);
                expect(options.max_tokens).toBe(LLM_STAGE_MAX_TOKENS[step]);
                expect(messages[0].content, step + ' system prompt persona').toContain(personas[step]);
            }
            // Each stage sees only its field: the conceptor gets the card, the
            // anatomy designer gets the world vocabulary, the later stages get
            // the previous stage's validated output (their only memory).
            expect(fakeLlm.chatFull.mock.calls[0][0][0].content, 'the concept system prompt').toContain('CHARACTER CONCEPTOR');
            expect(fakeLlm.chatFull.mock.calls[0][0][1].content).toContain('Nova');
            expect(fakeLlm.chatFull.mock.calls[1][0][0].content, 'the anatomy system prompt').toContain('ANATOMY FACTS');
            expect(fakeLlm.chatFull.mock.calls[1][0][0].content).toContain('AVAILABLE COMPONENTS');
            expect(fakeLlm.chatFull.mock.calls[1][0][0].content).toContain('m1CentralBody');
            expect(fakeLlm.chatFull.mock.calls[1][0][1].content, 'anatomy sees the concept').toContain(NOVA_CONCEPT.rationale);
            expect(fakeLlm.chatFull.mock.calls[2][0][1].content, 'organs see the anatomy').toContain('parcelStrap');
            expect(fakeLlm.chatFull.mock.calls[3][0][1].content, 'outfit sees the anatomy').toContain('m1CentralBody');
        });

        it('accepts a stage answer wrapped in a markdown code fence', async () => {
            queueDesignStages(fakeLlm.chatFull, {
                concept: '```json\n' + JSON.stringify(NOVA_CONCEPT) + '\n```'
            });
            const result = await controller.designBody(NOVA_STEM);
            expect(result.body.blueprintId).toBe('Nova');
        });

        it('uses the card stem as fallback identity when the card has no metadata', async () => {
            const minimalAnatomy = { structure: { component: 'm1Head', slot: null, children: [] } };
            queueDesignStages(fakeLlm.chatFull, {
                concept: { rationale: 'A modest body for a quiet character: nothing loud, nothing heavy.', focus: ['unremarkable frame'] },
                anatomy: minimalAnatomy
            });
            const result = await controller.designBody(QUIET_STEM);
            expect(result.card).toMatchObject({
                cardId: QUIET_STEM,
                name: 'Quiet',
                description: '',
                personality: ''
            });
            // The concept stage's prompt must note the missing fields so the
            // model does not hallucinate a description.
            const conceptMessages = fakeLlm.chatFull.mock.calls[0][0];
            expect(conceptMessages[1].content).toContain(
                'base the concept on the name alone'
            );
        });

        it('dresses the body: the outfit stage\'s garment and outfit survive composition', async () => {
            queueDesignStages(fakeLlm.chatFull, {
                outfit: {
                    garments: [{
                        name: 'courierCloak',
                        displayName: 'Ash-Cloaked Courier Mantle',
                        form: { volume: 4 },
                        materials: [{ material: 'wood', fraction: 1.0 }],
                        wear: { minVolume: 2 },
                        visual: { hue: 210, saturation: 40, lightness: 22, metalness: 0, roughness: 80 }
                    }],
                    outfit: [{ item: 'courierCloak', component: 'm1CentralBody' }]
                }
            });
            const result = await controller.designBody(NOVA_STEM);

            expect(result.body.garments).toEqual([{
                name: 'courierCloak',
                displayName: 'Ash-Cloaked Courier Mantle',
                form: { volume: 4 },
                materials: [{ material: 'wood', fraction: 1 }],
                wear: { minVolume: 2 },
                visual: { hue: 210, saturation: 40, lightness: 22, metalness: 0, roughness: 80 }
            }]);
            expect(result.body.outfit).toEqual([{ item: 'courierCloak', component: 'm1CentralBody' }]);
        });

        it('accepts a world item in the outfit, and an authored EMPTY outfit', async () => {
            queueDesignStages(fakeLlm.chatFull, {
                outfit: { outfit: [{ item: 'tshirt', component: 'm1CentralBody' }] }
            });
            const worn = await controller.designBody(NOVA_STEM);
            expect(worn.body.outfit).toEqual([{ item: 'tshirt', component: 'm1CentralBody' }]);

            // Empty is a claim; absent is not. The distinction decides at spawn
            // whether the world's default shirt is worn (`OutfitLogic.clothedByOutfit`).
            queueDesignStages(fakeLlm.chatFull, { outfit: { outfit: [] } });
            const dressedByAnEmptyList = await controller.designBody(NOVA_STEM);
            expect(dressedByAnEmptyList.body.outfit).toEqual([]);

            queueDesignStages(fakeLlm.chatFull); // the silent outfit stage (NO_OUTFIT)
            const saidNothing = await controller.designBody(NOVA_STEM);
            expect(saidNothing.body.outfit, 'a design that never spoke authors no clothing claim')
                .toBeUndefined();
        });

        it('gives up an outfit stage whose garment is not wearable, asks too much, or collides', async () => {
            const cases = [
                { bad: { garments: [ { name: 'noWear', form: { volume: 2 }, materials: [ { material: 'wood', fraction: 1 } ] } ] }, match: /wear\.minVolume/ },
                { bad: { garments: [ { name: 'tooGreedy', form: { volume: 2 }, materials: [ { material: 'wood', fraction: 1 } ], wear: { minVolume: 3 } } ] }, match: /wear\.minVolume/ },
                { bad: { garments: [ { name: 'tshirt', form: { volume: 2 }, materials: [ { material: 'wood', fraction: 1 } ], wear: { minVolume: 2 } } ] }, match: /collides with an existing item/ },
                { bad: { garments: [ { name: 'badMatter', form: { volume: 2 }, materials: [ { material: 'unobtainium', fraction: 1 } ], wear: { minVolume: 2 } } ] }, match: /is not an available material/ },
            ];
            for (const { bad, match } of cases) {
                queueStageFailure(fakeLlm.chatFull, 'outfit', bad);
                const error = await awaitThrown(controller.designBody(NOVA_STEM));
                expect(error, JSON.stringify(bad)).toBeInstanceOf(DesignStageError);
                expect(error.code).toBe('DESIGN_STAGE_FAILED');
                expect(error.step).toBe('outfit');
                expect(error.attempts).toBe(3);
                expect(error.errors.join(' ')).toMatch(match);
            }
        });

        it('gives up an outfit naming a part this body does not have, or an item that cannot be worn', async () => {
            queueStageFailure(fakeLlm.chatFull, 'outfit', {
                garments: [{ name: 'cloak', form: { volume: 2 }, materials: [{ material: 'wood', fraction: 1 }], wear: { minVolume: 2 } }],
                outfit: [{ item: 'cloak', component: 'maleTorso' }]
            });
            const partError = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(partError).toBeInstanceOf(DesignStageError);
            expect(partError.step).toBe('outfit');
            expect(partError.errors.join(' ')).toMatch(/is not a component of this body/);

            queueStageFailure(fakeLlm.chatFull, 'outfit', {
                outfit: [{ item: 'knife', component: 'm1CentralBody' }]
            });
            const itemError = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(itemError.errors.join(' ')).toMatch(/neither a proposed garment nor a wearable item/);
        });

        it('tells the outfit stage what the world already has to wear', async () => {
            queueDesignStages(fakeLlm.chatFull);
            await controller.designBody(NOVA_STEM);

            const system = fakeLlm.chatFull.mock.calls[3][0][0].content;
            expect(system).toContain('"garments"');
            expect(system).toContain('"outfit"');
            expect(system).toContain('WEARABLE ITEMS');
            // The t-shirt ships in the world; the outfit stage must offer it by
            // key (not by id, never by index) so the model can wear the real item
            // or author a better one. The expectation is built from the live item
            // registry, so a future world-data edit can't break this in vain.
            const tshirt = controller.items['tshirt'];
            expect(tshirt, 'the shipped t-shirt is in the world item registry').not.toBeUndefined();
            const tshirtLine = '- ' + tshirt.name + ' (' + tshirt.displayName + ', needs ' + tshirt.minVolume + ' free volume)';
            expect(system, 'the t-shirt is offered by key, with the volume the registry declares')
                .toContain(tshirtLine);
            expect(system, 'a garment is not a body part, and the prompt says so')
                .toContain('never a node of the body structure');
        });

        it('states the organ law in the organs stage prompt', async () => {
            queueDesignStages(fakeLlm.chatFull);
            await controller.designBody(NOVA_STEM);

            const system = fakeLlm.chatFull.mock.calls[2][0][0].content;
            expect(system).toContain('"internalComponents"');
            expect(system, 'a designer organ is a static claim').toContain('STATIC claim');
            expect(system, 'only the four function stats are grantable').toContain('Physical.strength');
            expect(system, 'flags come from the world\'s closed set').toContain('conductive');
            expect(system, 'an organ that grants nothing is rejected')
                .toMatch(/at least one of grants \/ grantsFlags per organ/);
            expect(system, 'a world part keeps the world\'s organs; only invented parts receive new ones')
                .toContain("keeps the world's own organs");
        });

        it('reports the organs each body part carries: world parts and new parts', async () => {
            const anatomy = {
                structure: {
                    component: 'm1CentralBody',
                    slot: null,
                    children: [
                        { component: 'm1Toe', slot: null, children: [] },
                        { component: 'parcelStrap', slot: 'hand', children: [] },
                        { component: 'm1Leg', slot: null, children: [] },
                        { component: 'm1Leg', slot: null, children: [] },
                        { component: 'm1Head', slot: null, children: [] }
                    ]
                },
                components: [
                    {
                        name: 'parcelStrap',
                        form: { volume: 3, position: { x: 2, y: 1 } },
                        materials: [{ material: 'iron', fraction: 1 }],
                        internalComponents: ['thinkCore']
                    }
                ]
            };
            queueDesignStages(fakeLlm.chatFull, {
                anatomy,
                organs: {
                    internalComponents: [{
                        name: 'courierWeb',
                        displayName: 'Courier Web',
                        grants: { 'Physical.strength': 70 },
                        grantsFlags: ['conductive'],
                        volume: 1,
                        component: 'parcelStrap'
                    }]
                }
            });
            const result = await controller.designBody(NOVA_STEM);

            // The organ the stage invented rides into the invented part's
            // recipe (the composer's attachment) and into the design's organ list.
            expect(result.body.internalComponents).toEqual([{
                name: 'courierWeb',
                displayName: 'Courier Web',
                grants: { 'Physical.strength': 70 },
                grantsFlags: ['conductive'],
                volume: 1
            }]);
            expect(result.body.components[0].internalComponents).toEqual(['thinkCore', 'courierWeb']);

            const organs = result.organsByComponent;
            expect(Object.isFrozen(organs), 'the map is display context: frozen').toBe(true);
            expect(Object.isFrozen(organs.m1CentralBody), 'each value is frozen too').toBe(true);
            expect(organs.m1CentralBody, 'world part: its world recipe organ').toEqual(['coalGenerator']);
            expect(organs.m1Head, 'world part: its own organ').toEqual(['thinkCore']);
            expect(organs.m1Leg, 'a part that appears twice is listed once').toEqual(['moveCore']);
            expect(organs.parcelStrap, 'new part: the design recipe organ plus the attached one').toEqual(['thinkCore', 'courierWeb']);
            expect('m1Toe' in organs, 'an inert part is absent, never an empty claim').toBe(false);
            expect(Object.keys(organs), 'tree order, first encounter first')
                .toEqual(['m1CentralBody', 'parcelStrap', 'm1Leg', 'm1Head']);
        });

        it('keeps what an anatomy mount declared about itself, and says nothing for a mount that did not', async () => {
            const anatomy = structuredClone(NOVA_ANATOMY);
            anatomy.structure.children[1].hidesWithParent = true;
            queueDesignStages(fakeLlm.chatFull, { anatomy });

            const result = await controller.designBody(NOVA_STEM);

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

        it('gives up an anatomy whose mount mark is not a boolean', async () => {
            const anatomy = structuredClone(NOVA_ANATOMY);
            anatomy.structure.children[1].hidesWithParent = 'yes';
            queueStageFailure(fakeLlm.chatFull, 'anatomy', anatomy);

            const error = await awaitThrown(controller.designBody(NOVA_STEM));

            expect(error).toBeInstanceOf(DesignStageError);
            expect(error.step).toBe('anatomy');
            expect(error.errors.join(' ')).toMatch(/hidesWithParent/);
        });

        it('says in the anatomy prompt what the mark means and where it belongs', async () => {
            queueDesignStages(fakeLlm.chatFull);
            await controller.designBody(NOVA_STEM);

            const system = fakeLlm.chatFull.mock.calls[1][0][0].content;
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

        // ---- stage-output validation failures (each stage gives up after its attempts) ----

        it('gives up the concept stage when the model does not answer with a JSON object', async () => {
            queueStageFailure(fakeLlm.chatFull, 'concept', 'sorry, i cannot build bodies');
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err).toBeInstanceOf(DesignStageError);
            expect(err.code).toBe('DESIGN_STAGE_FAILED');
            expect(err.step).toBe('concept');
            expect(err.errors).toContain('the model did not answer with a JSON object');
        });

        it('gives up a stage whose answer is a JSON array', async () => {
            queueStageFailure(fakeLlm.chatFull, 'concept', '[1, 2, 3]');
            await expect(controller.designBody(NOVA_STEM)).rejects.toThrow();
        });

        it('gives up an anatomy naming a component that is not available and not proposed', async () => {
            queueStageFailure(fakeLlm.chatFull, 'anatomy', {
                structure: { component: 'wingBlade', slot: null, children: [] }
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('anatomy');
            expect(err.errors.some((e) => e.includes('unknown component(s) in the body tree: wingBlade'))).toBe(true);
        });

        it('gives up an anatomy whose recipe fractions do not sum to 1.0', async () => {
            queueStageFailure(fakeLlm.chatFull, 'anatomy', {
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
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('anatomy');
            expect(err.errors.some((e) => e.includes('must sum to 1.0'))).toBe(true);
        });

        it('gives up an anatomy recipe naming an organ the world does not have', async () => {
            // The anatomy stage may reference ONLY world organs; the organs the
            // design invents arrive from the next stage, so a made-up name here
            // is a violation of this stage's law.
            queueStageFailure(fakeLlm.chatFull, 'anatomy', {
                structure: { component: 'm1Head', slot: null, children: [] },
                components: [
                    {
                        name: 'teleportCore',
                        form: { volume: 4, position: { x: 0, y: 0 } },
                        materials: [{ material: 'coal', fraction: 1 }],
                        internalComponents: ['teleportOrb']
                    }
                ]
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('anatomy');
            expect(err.errors.some((e) => e.includes('teleportOrb'))).toBe(true);
        });

        it('gives up an organ that attaches to a part the anatomy did not invent', async () => {
            queueStageFailure(fakeLlm.chatFull, 'organs', {
                internalComponents: [{
                    name: 'courierWeb',
                    grants: { 'Physical.strength': 70 },
                    volume: 1,
                    component: 'm1Head' // a WORLD part: the design never restates a world recipe
                }]
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('organs');
            expect(err.errors.join(' ')).toMatch(/not an invented part/);
        });

        it('gives up an organ that is attached to nothing (no "component")', async () => {
            queueStageFailure(fakeLlm.chatFull, 'organs', {
                internalComponents: [{
                    name: 'courierWeb',
                    grants: { 'Physical.strength': 70 },
                    volume: 1
                }]
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('organs');
            expect(err.errors.join(' ')).toMatch(/must attach to one of the body's INVENTED PARTS/);
        });

        it('gives up a designer organ that collides with an organ the world already has', async () => {
            queueStageFailure(fakeLlm.chatFull, 'organs', {
                internalComponents: [{ name: 'thinkCore', volume: 1, grants: { 'Mind.think_level': 5 }, component: 'parcelStrap' }]
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('organs');
            expect(err.errors.join(' ')).toMatch(/collides with an organ the world already has/);
        });

        it('gives up a designer organ grant outside the closed function-stat vocabulary', async () => {
            // mass is a MATTER-derived stat; an organ that granted it would give a
            // stat a second source and break one-source-per-stat derivation.
            queueStageFailure(fakeLlm.chatFull, 'organs', {
                internalComponents: [{ name: 'massGland', volume: 1, grants: { 'Physical.mass': 5 }, component: 'parcelStrap' }]
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('organs');
            expect(err.errors.join(' ')).toMatch(/is not grantable by an organ/);
        });

        it('gives up a designer organ that grants no stat and marks no flag (inert)', async () => {
            queueStageFailure(fakeLlm.chatFull, 'organs', {
                internalComponents: [{ name: 'hollowShell', displayName: 'Hollow Shell', volume: 1, component: 'parcelStrap' }]
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('organs');
            expect(err.errors.join(' ')).toMatch(/grants no stat and marks no flag/);
        });

        it('gives up a designer organ that carries a per-turn effect (a designer organ is static)', async () => {
            queueStageFailure(fakeLlm.chatFull, 'organs', {
                internalComponents: [{
                    name: 'regenNode',
                    volume: 1,
                    grants: { 'Physical.strength': 5 },
                    overTime: [{ type: 'restoreExistence', intervalTurns: 5, existenceGainPerInterval: 0.02, salvageConsumedPerInterval: 1 }],
                    component: 'parcelStrap'
                }]
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('organs');
            expect(err.errors.join(' ')).toMatch(/designer organ is a static claim/);
        });

        it('gives up a concept with a missing or empty rationale', async () => {
            queueStageFailure(fakeLlm.chatFull, 'concept', { focus: ['a quiet one'] });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('concept');
            expect(err.errors.some((e) => e.includes('"rationale" must be a string'))).toBe(true);
        });

        it('gives up a concept whose focus list is empty', async () => {
            queueStageFailure(fakeLlm.chatFull, 'concept', { rationale: 'a quiet one.', focus: [] });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('concept');
            expect(err.errors.some((e) => e.includes('"focus" must list at least one phrase'))).toBe(true);
        });

        it('gives up an anatomy over the node cap', async () => {
            const leaves = Array.from({ length: 17 }).map(() => ({
                component: 'm1Head', slot: null, children: []
            }));
            queueStageFailure(fakeLlm.chatFull, 'anatomy', {
                structure: {
                    component: 'm1Head',
                    slot: null,
                    children: leaves
                }
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('anatomy');
            expect(err.errors.some((e) => e.includes('18 nodes'))).toBe(true);
        });

        it('gives up a non-string body slot', async () => {
            queueStageFailure(fakeLlm.chatFull, 'anatomy', {
                structure: {
                    component: 'm1Leg',
                    slot: 5,
                    children: []
                }
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('anatomy');
            expect(err.errors.some((e) => e.includes('body-tree slot must be null or a non-empty string'))).toBe(true);
        });

        it('gives up a recipe name that collides with an existing component', async () => {
            queueStageFailure(fakeLlm.chatFull, 'anatomy', {
                structure: { component: 'm1Head', slot: null, children: [] },
                components: [
                    {
                        name: 'm1Head',
                        form: { volume: 3, position: { x: 1, y: 1 } },
                        materials: [{ material: 'iron', fraction: 1 }]
                    }
                ]
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.step).toBe('anatomy');
            expect(err.errors.some((e) => e.includes('collides with an existing or previously proposed component'))).toBe(true);
        });

        // ---- the retry discipline (E-6), driven through an injected pipeline ----

        it('retries a failed validation with the violated rules in the next prompt (corrective retry)', async () => {
            const fakeSleep = vi.fn().mockResolvedValue(undefined);
            const pipeline = new AgentBodyDesignPipeline({
                vocabulary: {
                    components: controller.components,
                    materials: controller.materials,
                    organs: controller.organs,
                    items: controller.items,
                    blueprints: controller.existingBlueprints
                },
                llmController: fakeLlm,
                sleep: fakeSleep
            });
            const injected = new AgentBodyController({ llmController: fakeLlm, pipeline });

            // First concept attempt fails validation (empty rationale); the
            // corrected second one passes. A corrective retry carries the
            // violated rules into the next prompt, so there is no backoff.
            fakeLlm.chatFull.mockReset();
            fakeLlm.chatFull
                .mockResolvedValueOnce({ content: JSON.stringify({ focus: ['a quiet one'] }), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify(NOVA_CONCEPT), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify(NOVA_ANATOMY), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify(NO_ORGANS), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify(NO_OUTFIT), finishReason: 'stop' });

            const result = await injected.designBody(NOVA_STEM);

            expect(result.body.blueprintId).toBe('Nova');
            expect(result.meta.stages[0].attempts).toBe(2);
            const secondConcept = fakeLlm.chatFull.mock.calls[1][0];
            expect(secondConcept[1].content, 'the violated rule rides into the corrective retry')
                .toContain('YOUR PREVIOUS ANSWER FOR THIS STAGE WAS REJECTED');
            expect(secondConcept[1].content).toContain('"rationale" must be a string');
            // A corrective retry waits for nothing: the prompt changed.
            expect(fakeSleep).not.toHaveBeenCalled();
        });

        it('retries a transient transport failure with exponential backoff, then the same prompt', async () => {
            const delays = [];
            const pipeline = new AgentBodyDesignPipeline({
                vocabulary: {
                    components: controller.components,
                    materials: controller.materials,
                    organs: controller.organs,
                    items: controller.items,
                    blueprints: controller.existingBlueprints
                },
                llmController: fakeLlm,
                sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
                rng: () => 0.5
            });
            const injected = new AgentBodyController({ llmController: fakeLlm, pipeline });

            // Two timeouts, then success: transient failures get a backoff
            // (base 1000ms, doubling, jitter 0.75 at rng 0.5) and the SAME
            // prompt again — nothing in it changed.
            fakeLlm.chatFull.mockReset();
            fakeLlm.chatFull
                .mockRejectedValueOnce(new LLMError('LLM request timed out', 'LLM_TIMEOUT'))
                .mockRejectedValueOnce(new LLMError('LLM request timed out', 'LLM_TIMEOUT'))
                .mockResolvedValueOnce({ content: JSON.stringify(NOVA_CONCEPT), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify(NOVA_ANATOMY), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify(NO_ORGANS), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify(NO_OUTFIT), finishReason: 'stop' });

            const result = await injected.designBody(NOVA_STEM);

            expect(result.body.blueprintId).toBe('Nova');
            expect(result.meta.stages[0].attempts).toBe(3);
            expect(delays, 'two backoffs: 1000*2^0*0.75, then 1000*2^1*0.75').toEqual([750, 1500]);
            // The repeated attempt re-sends the UNCHANGED prompt: a transport
            // retry is the same request, not a corrected one.
            expect(fakeLlm.chatFull.mock.calls[1][0][1].content).toBe(fakeLlm.chatFull.mock.calls[0][0][1].content);
        });

        it('propagates a non-retryable LLMError unchanged (a provider 4xx refusal is not transient)', async () => {
            const delays = [];
            const pipeline = new AgentBodyDesignPipeline({
                vocabulary: {
                    components: controller.components,
                    materials: controller.materials,
                    organs: controller.organs,
                    items: controller.items,
                    blueprints: controller.existingBlueprints
                },
                llmController: fakeLlm,
                sleep: (ms) => { delays.push(ms); return Promise.resolve(); }
            });
            const injected = new AgentBodyController({ llmController: fakeLlm, pipeline });

            fakeLlm.chatFull.mockReset();
            fakeLlm.chatFull.mockRejectedValueOnce(
                Object.assign(new LLMError('LLM provider refused the request', 'LLM_HTTP_ERROR'), { status: 400 })
            );
            const err = await awaitThrown(injected.designBody(NOVA_STEM));
            expect(err).toBeInstanceOf(LLMError);
            expect(err.code).toBe('LLM_HTTP_ERROR');
            // The seam error passes through untouched (no masking), and a 4xx
            // refusal is not retried: repeating it would change nothing.
            expect(err.message).toBe('LLM provider refused the request');
            expect(delays).toEqual([]);
        });

        it('reports the actual previous failure on each retry (a validation then a transport failure names transport, not the stale validation)', async () => {
            const events = [];
            const pipeline = new AgentBodyDesignPipeline({
                vocabulary: {
                    components: controller.components,
                    materials: controller.materials,
                    organs: controller.organs,
                    items: controller.items,
                    blueprints: controller.existingBlueprints
                },
                llmController: fakeLlm,
                sleep: vi.fn().mockResolvedValue(undefined),
                rng: () => 0.5,
                reporter: (event) => { events.push(event); }
            });
            const injected = new AgentBodyController({ llmController: fakeLlm, pipeline });

            // concept: attempt 1 fails validation (no rationale), attempt 2 times
            // out (transport), attempt 3 succeeds. The attempt-3 "retrying" report
            // must name the attempt-2 transport failure, not the stale
            // attempt-1 validation errors.
            fakeLlm.chatFull
                .mockReset()
                .mockResolvedValueOnce({
                    content: JSON.stringify({ focus: ['a quiet one'] }),
                    finishReason: 'stop'
                })
                .mockRejectedValueOnce(new LLMError('LLM request timed out', 'LLM_TIMEOUT'))
                .mockResolvedValueOnce({ content: JSON.stringify(NOVA_CONCEPT), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify(NOVA_ANATOMY), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify(NO_ORGANS), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify(NO_OUTFIT), finishReason: 'stop' });

            const result = await injected.designBody(NOVA_STEM);
            expect(result.body.blueprintId).toBe('Nova');
            expect(result.meta.stages[0].attempts).toBe(3);

            const retried = events.find((e) => e.step === 'concept' && e.attempt === 3 && e.status === 'retrying');
            expect(retried.error, 'the attempt-3 retrying report names the real previous failure')
                .toMatch(/transport:/);
            expect(retried.error).not.toMatch(/validation:/);
        });

        it('states the violated rules in a validation failure event (not just a count)', async () => {
            const events = [];
            const pipeline = new AgentBodyDesignPipeline({
                vocabulary: {
                    components: controller.components,
                    materials: controller.materials,
                    organs: controller.organs,
                    items: controller.items,
                    blueprints: controller.existingBlueprints
                },
                llmController: fakeLlm,
                sleep: vi.fn().mockResolvedValue(undefined),
                rng: () => 0.5,
                reporter: (event) => { events.push(event); }
            });
            const injected = new AgentBodyController({ llmController: fakeLlm, pipeline });

            // Three validation failures on concept exhaust the stage.
            fakeLlm.chatFull
                .mockReset()
                .mockResolvedValueOnce({ content: JSON.stringify({ focus: ['a quiet one'] }), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify({ focus: ['a quiet one'] }), finishReason: 'stop' })
                .mockResolvedValueOnce({ content: JSON.stringify({ focus: ['a quiet one'] }), finishReason: 'stop' });

            await awaitThrown(injected.designBody(NOVA_STEM));

            const failed = events.find((e) => e.step === 'concept' && e.status === 'failed');
            expect(failed.error, 'the failed validation event carries the violated rule text')
                .toMatch(/"rationale"/);
            expect(failed.error).not.toMatch(/rule\(s\)/);
        });

        it('does not retry an LLM_HTTP_ERROR with no status (absent status = non-transient, E-6 conservative)', async () => {
            const delays = [];
            const pipeline = new AgentBodyDesignPipeline({
                vocabulary: {
                    components: controller.components,
                    materials: controller.materials,
                    organs: controller.organs,
                    items: controller.items,
                    blueprints: controller.existingBlueprints
                },
                llmController: fakeLlm,
                sleep: (ms) => { delays.push(ms); return Promise.resolve(); },
                rng: () => 0.5
            });
            const injected = new AgentBodyController({ llmController: fakeLlm, pipeline });

            fakeLlm.chatFull
                .mockReset()
                .mockRejectedValueOnce(Object.assign(new LLMError('no status provided', 'LLM_HTTP_ERROR')));

            const err = await awaitThrown(injected.designBody(NOVA_STEM));
            expect(err).toBeInstanceOf(LLMError);
            expect(err.code).toBe('LLM_HTTP_ERROR');
            expect(err.status).toBeUndefined();
            expect(fakeLlm.chatFull).toHaveBeenCalledTimes(1);
            expect(delays, 'no backoff before a non-retryable transport failure').toEqual([]);
        });
    });


    describe('saveDesign (the "Save" action - writes one mod package, never the official data)', () => {
        const PACKAGE_DIR = 'data/mods/body-novarunner';

        /**
         * The save runs over a REAL `ModPackageWriter` whose data seam is an in-memory
         * store (TST-8: a test's fake is a module, not a global; TST-1: the writer is a
         * collaborator, not a spy on internals). Nothing here writes a file, and "the
         * official packages were not touched" is answered by the list of paths the store
         * was asked to write - a question with a yes/no answer, not an assumption.
         *
         * The clock is injected for the backup suffix (`D-1`): a test that asserts a
         * backup path asks for the time, it does not read it.
         */
        function makeSaveHarness() {
            const files = new Map();
            const written = [];
            const dataLoader = {
                exists: (relativePath) => files.has(relativePath),
                loadJsonSafe: (relativePath, fallback) => (files.has(relativePath) ? JSON.parse(files.get(relativePath)) : fallback),
                saveJson: (relativePath, data) => {
                    files.set(relativePath, JSON.stringify(data));
                    written.push(relativePath);
                },
                copyFile: (from, to) => {
                    if (files.has(from)) files.set(to, files.get(from));
                    return to;
                },
                ensureDir: () => undefined
            };
            const writer = new ModPackageWriter({ dataLoader, backupStamp: () => 1700000000000 });
            return {
                writer,
                written,
                has: (relativePath) => files.has(relativePath),
                read: (relativePath) => JSON.parse(files.get(relativePath)),
                controller: new AgentBodyController({
                    llmController: makeFakeLlmController(),
                    packageWriter: writer
                })
            };
        }

        it('writes the body as one package and never writes an official file', async () => {
            const harness = makeSaveHarness();
            const result = await harness.controller.saveDesign(HAPPY_BODY);

            expect(result.saved).toBe(true);
            expect(result.blueprintId).toBe('novaRunner');
            expect(result.packageId).toBe('body-novarunner');
            expect(result.dir).toBe(PACKAGE_DIR);
            expect(result.created).toBe(true);
            expect(result.version).toBe('1.0.0');
            expect(result.newComponents).toEqual(['parcelStrap']);
            expect(result.outfitWritten).toBe(false);
            expect(harness.written.some((p) => p.startsWith('data/mods/core-')), 'official data is never written').toBe(false);

            // The manifest is what the Mods panel reads: the id, the kinds it carries, and
            // a sentence naming where the body came from.
            expect(harness.read(`${PACKAGE_DIR}/mod.json`)).toMatchObject({
                id: 'body-novarunner',
                version: '1.0.0',
                content: ['components', 'blueprints']
            });
            expect(harness.read(`${PACKAGE_DIR}/mod.json`).description).toContain('novaRunner');

            // The package carries THIS body, not the world: no merge with the official
            // registry, so disabling it is what undoes the design.
            expect(harness.read(`${PACKAGE_DIR}/blueprints.json`)).toEqual({
                novaRunner: ['m1CentralBody'],
                m1CentralBody: [
                    'm1Head',
                    ['m1Leg', 'frontal_left'],
                    ['m1Leg', 'frontal_right'],
                    ['m1Toe', 'back']
                ],
                m1Leg: [['m1Toe', 'left']]
            });
            expect(harness.read(`${PACKAGE_DIR}/components.json`)).toEqual({
                parcelStrap: {
                    name: 'parcelStrap',
                    form: { volume: 3, position: { x: 2, y: 1 } },
                    materials: [
                        { material: 'iron', fraction: 0.6 },
                        { material: 'wood', fraction: 0.4 }
                    ],
                    internalComponents: ['thinkCore'],
                    energyCapacity: 10
                }
            });
        });

        it('reports the official keys the package shadows, and only those', async () => {
            const harness = makeSaveHarness();
            const result = await harness.controller.saveDesign(HAPPY_BODY);

            // Redefining a part sub-tree IS redesigning a card, so it is written and
            // reported - not filtered away. `novaRunner` is new, so it shadows nothing.
            const shadowedKeys = result.overlapsOfficial.map((overlap) => overlap.key);
            expect(shadowedKeys).toEqual(expect.arrayContaining(['m1CentralBody', 'm1Leg']));
            expect(shadowedKeys).not.toContain('novaRunner');
            expect(result.overlapsOfficial.every((overlap) => overlap.kind === REGISTRY_KINDS.BLUEPRINTS)).toBe(true);
        });

        it('writes a mount mark as the third element of the mount, in the shape the world reads', async () => {
            const design = structuredClone(HAPPY_BODY);
            // One marked mount with a slot, one without. The slotless one is the
            // interesting case: the mark is the THIRD element of the mount, so a
            // marked joint with no slot has to say the identifier `expandBlueprint`
            // itself would have given it - never invent a body position to carry a mark.
            design.structure.children[0].hidesWithParent = true;  // m1Head, no slot
            design.structure.children[3].hidesWithParent = true;  // m1Toe, 'back'
            const harness = makeSaveHarness();
            await harness.controller.saveDesign(design);

            const bl = harness.read(`${PACKAGE_DIR}/blueprints.json`);
            expect(bl.m1CentralBody).toEqual([
                ['m1Head', 'default', { hidesWithParent: true }],
                ['m1Leg', 'frontal_left'],
                ['m1Leg', 'frontal_right'],
                ['m1Toe', 'back', { hidesWithParent: true }]
            ]);

            // The shape the design WRITES is the shape the live world READS:
            // instantiate the saved blueprint with the real EntityController, over
            // the written file - not over a row this test typed by hand.
            const spawned = new EntityController(
                new ComponentController(
                    new ComponentStatsController(),
                    new TraitsController({}),
                    DataLoader.loadRegistry(REGISTRY_KINDS.COMPONENTS)
                ),
                bl
            ).createEntityFromBlueprint('novaRunner');
            expect(spawned.components.filter((c) => c.hidesWithParent === true).map((c) => c.type).sort())
                .toEqual(['m1Head', 'm1Toe']);
        });

        it('carries the invented garment and the outfit as their own kinds of the same package', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.garments = [{
                name: 'courierCloak',
                displayName: 'Ash-Cloaked Courier Mantle',
                form: { volume: 4 },
                materials: [{ material: 'wood', fraction: 1.0 }],
                wear: { minVolume: 2 },
                visual: { hue: 210, saturation: 40, lightness: 22, metalness: 0, roughness: 80 }
            }];
            design.outfit = [{ item: 'courierCloak', component: 'm1CentralBody' }];
            const harness = makeSaveHarness();
            const result = await harness.controller.saveDesign(design);

            expect(result.newItems).toEqual(['courierCloak']);
            expect(result.outfitWritten).toBe(true);
            expect(harness.read(`${PACKAGE_DIR}/inventoryItems.json`)).toEqual({
                courierCloak: {
                    // The prose speaks the display name, not the registry key.
                    name: 'Ash-Cloaked Courier Mantle',
                    description: 'A garment authored from a character card in the Create Agent Body dev tab.',
                    form: { volume: 4 },
                    materials: [{ material: 'wood', fraction: 1 }],
                    internalComponents: [],
                    wear: { minVolume: 2 },
                    visual: { hue: 210, saturation: 40, lightness: 22, metalness: 0, roughness: 80 }
                }
            });
            // Same key the body was written under: designing it and dressing it are
            // two writes keyed by one thing (`wiki/decisions/outfits.md`).
            expect(harness.read(`${PACKAGE_DIR}/outfits.json`)).toEqual({
                novaRunner: [{ item: 'courierCloak', component: 'm1CentralBody' }]
            });
            expect(harness.written.some((p) => p.startsWith('data/mods/core-')), 'official items and outfits are never written').toBe(false);
        });

        it('writes the designer\'s own organ as its own kind of the package, referenced by its component', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.internalComponents = [{
                name: 'courierWeb',
                displayName: 'Courier Web',
                grants: { 'Physical.strength': 70 },
                grantsFlags: ['conductive'],
                volume: 1
            }];
            design.components[0].internalComponents = ['courierWeb'];
            const harness = makeSaveHarness();
            const result = await harness.controller.saveDesign(design);

            expect(result.newOrgans).toEqual(['courierWeb']);
            // The written entry follows the world's IC definition shape (the `name` field is
            // the display name, the key is the type id - the convention the official file uses):
            // the IC registry accepts it as-is at POST /mods/apply.
            expect(harness.read(`${PACKAGE_DIR}/internalComponents.json`)).toEqual({
                courierWeb: {
                    name: 'Courier Web',
                    volume: 1,
                    grants: { 'Physical.strength': 70 },
                    grantsFlags: ['conductive']
                }
            });
            // The component that names the organ keeps the reference in the written recipe.
            expect(harness.read(`${PACKAGE_DIR}/components.json`).parcelStrap.internalComponents).toEqual(['courierWeb']);
            expect(harness.written.some((p) => p.startsWith('data/mods/core-')), 'the official organ file is never written').toBe(false);
        });

        it('omits the organ kind entirely when the design proposed no organs', async () => {
            const harness = makeSaveHarness();
            const result = await harness.controller.saveDesign(HAPPY_BODY);

            expect(result.newOrgans).toEqual([]);
            // An absent kind is not an empty kind: ModPackageWriter refuses an empty one, and
            // "invented no organs" must not become "authored an empty registry".
            expect(harness.has(`${PACKAGE_DIR}/internalComponents.json`)).toBe(false);
        });

        it('omits the clothing kinds entirely when the design said nothing about clothing', async () => {
            const harness = makeSaveHarness();
            const result = await harness.controller.saveDesign(HAPPY_BODY);

            expect(result.newItems).toEqual([]);
            expect(result.outfitWritten).toBe(false);
            // An absent kind is not an empty kind: `ModPackageWriter` refuses an empty
            // one, and "said nothing" must not become "authored nothing".
            expect(harness.has(`${PACKAGE_DIR}/inventoryItems.json`)).toBe(false);
            expect(harness.has(`${PACKAGE_DIR}/outfits.json`)).toBe(false);
        });

        it('writes an authored EMPTY outfit: born wearing nothing is a claim, not an absence', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.outfit = [];
            const harness = makeSaveHarness();
            const result = await harness.controller.saveDesign(design);

            expect(result.outfitWritten).toBe(true);
            // An empty list under the key is what the world reads as "clothed by the
            // registry, wearing nothing", so the spawn default stands down.
            expect(harness.read(`${PACKAGE_DIR}/outfits.json`)).toEqual({ novaRunner: [] });
        });

        it('rewrites the same card as the same package, with a backup and a version step', async () => {
            const harness = makeSaveHarness();
            const first = await harness.controller.saveDesign(HAPPY_BODY);
            const before = harness.written.length;

            const second = await harness.controller.saveDesign(HAPPY_BODY);

            expect(second.packageId).toBe(first.packageId);
            expect(second.created).toBe(false);
            expect(second.version).toBe('1.0.1');
            // Every file the rewrite replaces was copied aside first, so a redesign is
            // undoable by hand - the writer's rule, not a second one invented here.
            expect(second.overwritten).toEqual(expect.arrayContaining(['components', 'blueprints']));
            expect(second.backups).toEqual([
                `${PACKAGE_DIR}/components.json.bak-1700000000000`,
                `${PACKAGE_DIR}/blueprints.json.bak-1700000000000`
            ]);
            expect(harness.written.slice(before)).toEqual([
                `${PACKAGE_DIR}/components.json`,
                `${PACKAGE_DIR}/blueprints.json`,
                `${PACKAGE_DIR}/mod.json`
            ]);
        });

        it('folds a card display name into a package id, and refuses one with nothing to fold', async () => {
            const harness = makeSaveHarness();
            const folded = async (blueprintId) => {
                const design = structuredClone(HAPPY_BODY);
                design.blueprintId = blueprintId;
                const saved = await harness.controller.saveDesign(design);
                return saved.packageId;
            };

            expect(await folded('Nova, Seamstress of the Ward!')).toBe('body-nova-seamstress-of-the-ward');
            // Escapes, not literals: the source stays ASCII (CR NAME-1) while the NAME the
            // world speaks still carries its accents. NFD splits the glyph into a base
            // letter plus a combining mark, which is what makes the fold possible.
            expect(await folded('Ana\u00efse')).toBe('body-anaise');
            expect(await folded('  M\u00fcller  ')).toBe('body-muller');

            const design = structuredClone(HAPPY_BODY);
            design.blueprintId = '\u2665\u2665';
            const error = await awaitThrown(harness.controller.saveDesign(design));
            expect(error).toBeInstanceOf(DesignValidationError);
            expect(error.errors[0]).toContain('no ASCII letters or digits to name the package from');
        });

        it('rejects a blueprintId that is a sub-tree part (droid type must be a distinct key)', async () => {
            const harness = makeSaveHarness();
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
            const error = await awaitThrown(harness.controller.saveDesign(design));
            expect(error).toBeInstanceOf(DesignValidationError);
            expect(error.errors[0]).toContain('must not be the name of any component used in the body tree');
            expect(harness.written, 'a refused design writes nothing at all').toEqual([]);
        });

        it('rejects a design referencing a component that is neither in the catalog nor proposed', async () => {
            const harness = makeSaveHarness();
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
            const error = await awaitThrown(harness.controller.saveDesign(design));
            expect(error).toBeInstanceOf(DesignValidationError);
            expect(error.message).toMatch(/unknown component/);
            expect(harness.written, 'a refused design writes nothing at all').toEqual([]);
        });
    });
});
