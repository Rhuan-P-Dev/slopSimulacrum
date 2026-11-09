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
 * A design object that passes every validation rule (all structure components
 * exist in the catalog; one new recipe with valid fractions and a valid organ).
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
    describe('designBody', () => {
        it('returns a validated design with the prompt captured in meta (happy path)', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify(HAPPY_BODY),
                finishReason: 'stop'
            });
            const result = await controller.designBody(NOVA_STEM);

            expect(result.card).toEqual({
                cardId: NOVA_STEM,
                name: 'Nova',
                description: 'A small fox-like courier droid that runs jobs across the town. Likes the smell of coal and hates the rain.',
                personality: 'Helpful but clumsy. Asks for permission before moving other things.'
            });
            expect(result.body.blueprintId).toBe('Nova');
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
            expect(messages[1].content).toContain('Nova');
            expect(options.temperature).toBe(LLM_DEFAULT_TEMPERATURE);
            expect(options.max_tokens).toBe(LLM_AGENT_BODY_MAX_TOKENS);
        });

        it('accepts the model output wrapped in a markdown code fence', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: '```json\n' + JSON.stringify(HAPPY_BODY) + '\n```',
                finishReason: 'complete'
            });
            const result = await controller.designBody(NOVA_STEM);
            expect(result.body.blueprintId).toBe('Nova');
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

        it('dresses the body: a garment it invents and the outfit that wears it survive normalization', async () => {
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
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });

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

        it('accepts a garment the world already has, and an authored EMPTY outfit', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.outfit = [{ item: 'tshirt', component: 'm1CentralBody' }];
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });
            const worn = await controller.designBody(NOVA_STEM);
            expect(worn.body.outfit).toEqual([{ item: 'tshirt', component: 'm1CentralBody' }]);

            // Empty is a claim; absent is not. The distinction decides at spawn whether
            // the world's default shirt is worn (`OutfitLogic.clothedByOutfit`).
            const naked = structuredClone(HAPPY_BODY);
            naked.outfit = [];
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(naked), finishReason: 'stop' });
            const dressedByAnEmptyList = await controller.designBody(NOVA_STEM);
            expect(dressedByAnEmptyList.body.outfit).toEqual([]);

            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(HAPPY_BODY), finishReason: 'stop' });
            const saidNothing = await controller.designBody(NOVA_STEM);
            expect(saidNothing.body.outfit, 'a design that never spoke authors no clothing claim')
                .toBeUndefined();
        });

        it('rejects a garment that is not wearable, asks more than its own volume, or collides', async () => {
            const cases = [
                { garment: { name: 'noWear', form: { volume: 2 }, materials: [{ material: 'wood', fraction: 1 }] }, match: /wear\.minVolume/ },
                { garment: { name: 'tooGreedy', form: { volume: 2 }, materials: [{ material: 'wood', fraction: 1 }], wear: { minVolume: 3 } }, match: /wear\.minVolume/ },
                { garment: { name: 'tshirt', form: { volume: 2 }, materials: [{ material: 'wood', fraction: 1 }], wear: { minVolume: 2 } }, match: /collides with an existing item/ },
                { garment: { name: 'badMatter', form: { volume: 2 }, materials: [{ material: 'unobtainium', fraction: 1 }], wear: { minVolume: 2 } }, match: /is not an available material/ }
            ];
            for (const { garment, match } of cases) {
                const design = structuredClone(HAPPY_BODY);
                design.garments = [garment];
                fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });
                const error = await awaitThrown(controller.designBody(NOVA_STEM));
                expect(error, garment.name).toBeInstanceOf(DesignValidationError);
                expect(error.errors.join(' ')).toMatch(match);
            }
        });

        it('rejects an outfit naming a part this body does not have, or an item that cannot be worn', async () => {
            const wrongPart = structuredClone(HAPPY_BODY);
            wrongPart.garments = [{ name: 'cloak', form: { volume: 2 }, materials: [{ material: 'wood', fraction: 1 }], wear: { minVolume: 2 } }];
            wrongPart.outfit = [{ item: 'cloak', component: 'maleTorso' }];
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(wrongPart), finishReason: 'stop' });
            const partError = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(partError).toBeInstanceOf(DesignValidationError);
            expect(partError.errors.join(' ')).toMatch(/is not a component of this body/);

            const knife = structuredClone(HAPPY_BODY);
            knife.outfit = [{ item: 'knife', component: 'm1CentralBody' }];
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(knife), finishReason: 'stop' });
            const itemError = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(itemError.errors.join(' ')).toMatch(/not a wearable item/);
        });

        it('tells the model about garments, the outfit, and what the world already has to wear', async () => {
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(HAPPY_BODY), finishReason: 'stop' });
            await controller.designBody(NOVA_STEM);

            const system = fakeLlm.chatFull.mock.calls.at(-1)[0][0].content;
            expect(system).toContain('"garments"');
            expect(system).toContain('"outfit"');
            expect(system).toContain('WEARABLE ITEMS');
            expect(system, 'the shipped t-shirt is offered by key, with the volume it needs')
                .toMatch(/tshirt \(T-Shirt, needs 2 free volume\)/);
            expect(system, 'a garment is not a body part, and the prompt says so')
                .toMatch(/never a node of "structure"/);
        });

        it('states the display-name limits and the pre-answer name checklist', async () => {
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(HAPPY_BODY), finishReason: 'stop' });
            await controller.designBody(NOVA_STEM);

            const system = fakeLlm.chatFull.mock.calls.at(-1)[0][0].content;
            expect(system, 'the display-name limit is said, not only enforced')
                .toMatch(/at most 64 characters/);
            expect(system, 'a checklist pins the model to the rules just before output format')
                .toContain('FINAL CHECKLIST');
            expect(system, 'a recipe organ must match a shipped organ or a same-design proposal')
                .toContain('every string in every "internalComponents"');
            expect(system, 'an unproposed organ needs a same-design definition')
                .toContain('MUST also define it in the top-level "internalComponents" in the SAME design');
            expect(system, 'the checklist names the rejection the card would get')
                .toContain('rejects as BODY_DESIGN_INVALID');
            const checklistIdx = system.indexOf('FINAL CHECKLIST');
            const formatIdx = system.indexOf('OUTPUT FORMAT:');
            expect(checklistIdx, 'the checklist exists').toBeGreaterThan(-1);
            expect(formatIdx, 'the checklist reads after the examples and before the output-format line')
                .toBeGreaterThan(checklistIdx);
        });

        it('reports the organs each body part carries: world parts and new parts', async () => {
            const design = {
                blueprintId: 'novaRunner',
                rationale: 'a body mixing an inert part, organ-bearing world parts, and one new part with its own organ.',
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
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });
            const result = await controller.designBody(NOVA_STEM);

            const organs = result.organsByComponent;
            expect(Object.isFrozen(organs), 'the map is display context: frozen').toBe(true);
            expect(Object.isFrozen(organs.m1CentralBody), 'each value is frozen too').toBe(true);
            expect(organs.m1CentralBody, 'world part: its world recipe organ').toEqual(['coalGenerator']);
            expect(organs.m1Head, 'world part: its own organ').toEqual(['thinkCore']);
            expect(organs.m1Leg, 'a part that appears twice is listed once').toEqual(['moveCore']);
            expect(organs.parcelStrap, 'new part: the design recipe organ').toEqual(['thinkCore']);
            expect('m1Toe' in organs, 'an inert part is absent, never an empty claim').toBe(false);
            expect(Object.keys(organs), 'tree order, first encounter first')
                .toEqual(['m1CentralBody', 'parcelStrap', 'm1Leg', 'm1Head']);
        });

        it('resolves a new-part organ given as { type, grants } objects to its type id', async () => {
            const design = {
                blueprintId: 'novaRunner',
                rationale: 'a new part names its organ in the model-side object shape.',
                structure: {
                    component: 'm1CentralBody',
                    slot: null,
                    children: [
                        { component: 'parcelStrap', slot: 'hand', children: [] },
                        { component: 'm1Head', slot: null, children: [] }
                    ]
                },
                components: [
                    {
                        name: 'parcelStrap',
                        form: { volume: 3, position: { x: 2, y: 1 } },
                        materials: [{ material: 'iron', fraction: 1 }],
                        internalComponents: [{ type: 'thinkCore', grants: {} }]
                    }
                ]
            };
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });
            const result = await controller.designBody(NOVA_STEM);

            expect(result.body.components[0].internalComponents[0],
                'the object form survives validation and normalization').toEqual({
                type: 'thinkCore',
                grants: {}
            });
            expect(result.organsByComponent.parcelStrap,
                'the tree shows the type id, not the object').toEqual(['thinkCore']);
        });

        it('keeps what a mount declared about itself, and says nothing for a mount that did not', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.structure.children[1].hidesWithParent = true;
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });

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

        it('rejects a mount mark that is not a boolean', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.structure.children[1].hidesWithParent = 'yes';
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });

            const error = await awaitThrown(controller.designBody(NOVA_STEM));

            expect(error).toBeInstanceOf(DesignValidationError);
            expect(error.errors.join(' ')).toMatch(/hidesWithParent/);
        });

        it('says in the prompt what the mark means and where it belongs', async () => {
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(HAPPY_BODY), finishReason: 'stop' });
            await controller.designBody(NOVA_STEM);

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
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err).toBeInstanceOf(DesignValidationError);
            expect(err.code).toBe('BODY_DESIGN_INVALID');
            expect(err.errors).toContain('the design was not a JSON object');
            expect(err.message).toContain('card "nova"');
        });

        it('rejects when the model output is a JSON array', async () => {
            fakeLlm.chatFull.mockResolvedValue({ content: '[1, 2, 3]', finishReason: 'stop' });
            await expect(controller.designBody(NOVA_STEM)).rejects.toThrow();
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
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
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
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
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
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.errors.some((e) => e.includes('teleportOrb'))).toBe(true);
        });

        it('authors its own organs: a proposed organ a component references survives validation', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.internalComponents = [{
                name: 'courierWeb',
                displayName: 'Courier Web',
                grants: { 'Physical.strength': 70 },
                grantsFlags: ['conductive'],
                volume: 1
            }];
            // A component of this body names the organ the design invented.
            design.components[0].internalComponents = ['courierWeb'];
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });

            const result = await controller.designBody(NOVA_STEM);

            expect(result.body.internalComponents).toEqual([{ name: 'courierWeb', displayName: 'Courier Web', grants: { 'Physical.strength': 70 }, grantsFlags: ['conductive'], volume: 1 }]);
            // A design that invents no organs normalizes to an empty list, not an absence:
            // downstream code (the save) iterates it unconditionally.
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(HAPPY_BODY), finishReason: 'stop' });
            const noOrgans = await controller.designBody(NOVA_STEM);
            expect(noOrgans.body.internalComponents).toEqual([]);
        });

        it('rejects a designer organ that collides with an organ the world already has', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.internalComponents = [{ name: 'thinkCore', volume: 1, grants: { 'Mind.think_level': 5 } }];
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err).toBeInstanceOf(DesignValidationError);
            expect(err.errors.join(' ')).toMatch(/collides with an organ the world already has/);
        });

        it('rejects a designer organ grant outside the closed function-stat vocabulary', async () => {
            // mass is a MATTER-derived stat; an organ that granted it would give a stat a
            // second source and break one-source-per-stat derivation.
            const design = structuredClone(HAPPY_BODY);
            design.internalComponents = [{ name: 'massGland', volume: 1, grants: { 'Physical.mass': 5 } }];
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err).toBeInstanceOf(DesignValidationError);
            expect(err.errors.join(' ')).toMatch(/is not grantable by an organ/);
        });

        it('rejects a designer organ that grants no stat and marks no flag (inert)', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.internalComponents = [{ name: 'hollowShell', displayName: 'Hollow Shell', volume: 1 }];
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err).toBeInstanceOf(DesignValidationError);
            expect(err.errors.join(' ')).toMatch(/grants no stat and marks no flag/);
        });

        it('rejects a designer organ that carries a per-turn effect (a designer organ is static)', async () => {
            const design = structuredClone(HAPPY_BODY);
            design.internalComponents = [{
                name: 'regenNode',
                volume: 1,
                grants: { 'Physical.strength': 5 },
                overTime: [{ type: 'restoreExistence', intervalTurns: 5, existenceGainPerInterval: 0.02, salvageConsumedPerInterval: 1 }]
            }];
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(design), finishReason: 'stop' });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err).toBeInstanceOf(DesignValidationError);
            expect(err.errors.join(' ')).toMatch(/designer organ is static/);
        });

        it('says in the prompt what a designer organ is: static grants over a closed vocabulary', async () => {
            fakeLlm.chatFull.mockResolvedValue({ content: JSON.stringify(HAPPY_BODY), finishReason: 'stop' });
            await controller.designBody(NOVA_STEM);

            const system = fakeLlm.chatFull.mock.calls.at(-1)[0][0].content;
            expect(system).toContain('"internalComponents"');
            expect(system, 'the organ field is named the designer\'s own organs').toContain('the designer\'s own ICs');
            expect(system, 'only the four function stats are grantable').toContain('Physical.strength');
            expect(system, 'flags come from the world\'s closed set').toContain('conductive');
            expect(system, 'an organ that grants nothing is rejected').toMatch(/at least a grant or a flag/);
        });

        it('rejects a missing or empty rationale', async () => {
            fakeLlm.chatFull.mockResolvedValue({
                content: JSON.stringify({
                    blueprintId: 'noRationale',
                    structure: { component: 'm1Head', slot: null, children: [] }
                }),
                finishReason: 'stop'
            });
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
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
            // used — designBody replaces it with the card display name ('Nova'),
            // so there is no collision with the existing 'm1Droid' blueprint.
            const result = await controller.designBody(NOVA_STEM);
            expect(result.body.blueprintId).toBe('Nova');
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
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
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
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
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
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err.errors.some((e) => e.includes('collides with an existing or previously proposed component'))).toBe(true);
        });

        it('propagates LLMError through unchanged (timeout class)', async () => {
            fakeLlm.chatFull.mockRejectedValueOnce(
                new LLMError('LLM request timed out after 3000000ms', 'LLM_TIMEOUT')
            );
            const err = await awaitThrown(controller.designBody(NOVA_STEM));
            expect(err).toBeInstanceOf(LLMError);
            expect(err.code).toBe('LLM_TIMEOUT');
            // The seam error must pass through untouched (no masking).
            expect(err.message).toBe('LLM request timed out after 3000000ms');
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
