/**
 * CardUserRelationshipController - unit tests (the fifth LLM prompt kind,
 * `card-user-relationship`).
 *
 * The LLM seam is faked (TST-2 - the real provider is covered by the live
 * smoke test, not by these tests). The card directory is a temp dir (TST-8:
 * ephemeral state in beforeAll/afterAll), so the suite never touches the
 * user's `data/cards/`. Synthetic PNGs use the same framing as the reader
 * tests: the reader does not validate CRCs, so the CRC bytes are zero.
 *
 * @module test/unit/CardUserRelationshipController
 */

import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import CardUserRelationshipController, {
    CardNotFoundError,
    CardUserTokenAbsentError,
    RelationshipJudgmentError,
    personaHashFor,
    PROMPT_KIND,
    PROMPT_VERSION,
    LLM_CARD_USER_RELATIONSHIP_MAX_TOKENS,
    RELATIONSHIP_LABEL_MAX_CHARS,
    RELATIONSHIP_SUMMARY_MAX_CHARS
} from '../../src/controllers/networking/CardUserRelationshipController.js';
import { LLMError } from '../../src/utils/CustomErrors.js';
import { SIDECAR_VERSION } from '../../src/utils/CardRelationshipStore.js';

const NOVA_PERSONA = 'Nova adores {{user}} and would cross the world to sit beside {{user}}.';
const DESC_PERSONA = 'Desc treats {{user}} like a nuisance to be endured.';
const NO_TOKEN_PERSONA = 'A sardonic drone who answers questions. It never mentions anyone in particular.';

let tmpDir;

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
 * A fake LLM seam (TST-2): answers the judgment prompt with a good verdict
 * unless the test overrides the `chatFull` mock.
 */
function makeFakeLlm() {
    const good = JSON.stringify({
        label: 'devoted partner',
        summary: 'Nova is devoted to {{user}} and would cross the world for them.'
    });
    return {
        chatFull: vi.fn(async () => ({
            id: 'chatcmpl-fake',
            content: good,
            finishReason: 'stop',
            model: 'fake-model',
            usage: { promptTokens: 10, completionTokens: 12, totalTokens: 22 }
        }))
    };
}

async function writeCard(fileName, cardData) {
    fs.writeFileSync(path.join(tmpDir, fileName), buildCardPng(cardData));
}

let llm;
let controller;

beforeAll(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'card-user-rel-'));
    await writeCard('nova.png', {
        name: 'Nova',
        personality: NOVA_PERSONA,
        description: 'A small fox courier'
    });
    await writeCard('quiet.png', {
        name: 'Quiet',
        personality: NO_TOKEN_PERSONA,
        description: 'A drone with no opinions.'
    });
    // The precedence case: an empty personality falls through to the
    // description, which carries the token.
    await writeCard('desc.png', {
        name: 'Desc',
        personality: '',
        description: DESC_PERSONA
    });
    llm = makeFakeLlm();
    controller = new CardUserRelationshipController({ llmController: llm, cardDir: tmpDir });
});

afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CardUserRelationshipController', () => {

    it('rejects a constructor without the LLM seam (CR B-4)', () => {
        expect(() => new CardUserRelationshipController({})).toThrow();
        expect(() => new CardUserRelationshipController({ llmController: {} })).toThrow();
    });

    // ------------------------------------------------------------ listing
    it('lists nothing before any judgment exists', () => {
        expect(controller.listCardUserRelationships()).toEqual({});
    });

    // ------------------------------------------------------------ judging
    it('judges a token-bearing card: frozen result, named prompt kind and version', async () => {
        const result = await controller.judgeCardUserRelationship('nova');
        expect(Object.isFrozen(result)).toBe(true);
        expect(result.card).toEqual({ cardId: 'nova', name: 'Nova' });
        expect(result.relationship.label).toBe('devoted partner');
        expect(result.relationship.summary).toContain('devoted');
        expect(result.judgedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(result.meta).toEqual({
            promptKind: PROMPT_KIND,
            promptVersion: PROMPT_VERSION,
            model: 'fake-model',
            finishReason: 'stop',
            latencyMs: expect.any(Number)
        });
    });

    it('calls the LLM seam with the versioned prompt kind in the system prompt and the cost guard', async () => {
        llm.chatFull.mockClear();
        await controller.judgeCardUserRelationship('nova');
        expect(llm.chatFull).toHaveBeenCalledTimes(1);
        const [messages, options] = llm.chatFull.mock.calls[0];
        expect(options).toEqual({
            max_tokens: LLM_CARD_USER_RELATIONSHIP_MAX_TOKENS,
            temperature: null
        });
        expect(messages[0].role).toBe('system');
        expect(messages[0].content).toContain(PROMPT_KIND);
        expect(messages[0].content).toContain(PROMPT_VERSION);
        // The judgment grounds on the effective persona, verbatim.
        expect(messages[1].content).toContain(NOVA_PERSONA);
        expect(messages[1].content).toContain('Character name: Nova');
    });

    it('persists the judgment as a sidecar next to the card PNG, with the persona fingerprint', async () => {
        llm.chatFull.mockClear();
        await controller.judgeCardUserRelationship('nova');
        const sidecarPath = path.join(tmpDir, 'nova.user-relationship.json');
        expect(fs.existsSync(sidecarPath)).toBe(true);
        const record = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
        expect(record.version).toBe(SIDECAR_VERSION);
        expect(record.cardId).toBe('nova');
        expect(record.name).toBe('Nova');
        expect(record.personaHash).toBe(personaHashFor('Nova', NOVA_PERSONA));
        expect(record.judgedAt).toMatch(/Z$/);
        expect(record.relationship.label).toBe('devoted partner');
        // The PNG itself is never written by this feature (language policy):
        // it is still exactly the bytes the test fixture wrote.
        expect(fs.readFileSync(path.join(tmpDir, 'nova.png')).equals(buildCardPng({
            name: 'Nova',
            personality: NOVA_PERSONA,
            description: 'A small fox courier'
        }))).toBe(true);
    });

    it('serves the fresh sidecar in the listing after a judgment', async () => {
        await controller.judgeCardUserRelationship('nova');
        const relationships = controller.listCardUserRelationships();
        expect(Object.keys(relationships)).toEqual(['nova']);
        expect(relationships.nova.label).toBe('devoted partner');
        expect(relationships.nova.summary).toContain('devoted');
        expect(relationships.nova.judgedAt).toMatch(/Z$/);
    });

    it('judges through the description when the personality is empty (the spawn precedence)', async () => {
        await controller.judgeCardUserRelationship('desc');
        const relationships = controller.listCardUserRelationships();
        expect(relationships.desc).toBeDefined();
        const record = JSON.parse(fs.readFileSync(path.join(tmpDir, 'desc.user-relationship.json'), 'utf8'));
        expect(record.personaHash).toBe(personaHashFor('Desc', DESC_PERSONA));
    });

    // ------------------------------------------------------------ invalidation
    it('does not serve a judgment whose persona moved on, and a re-judge rewrites the sidecar', async () => {
        await controller.judgeCardUserRelationship('nova');
        // The user replaces the card file with a different persona (the
        // token stays: only the words move on): the judgment no longer
        // describes the card on disk.
        await writeCard('nova.png', {
            name: 'Nova',
            personality: 'Nova has grown cold toward {{user}} and keeps her distance now.',
            description: 'A small fox courier'
        });
        // The earlier tests judged `desc`, whose card file is unchanged, so
        // it is still served; the assertion is about `nova` only.
        expect(controller.listCardUserRelationships().nova).toBeUndefined();
        await controller.judgeCardUserRelationship('nova');
        const relationships = controller.listCardUserRelationships();
        const record = JSON.parse(fs.readFileSync(path.join(tmpDir, 'nova.user-relationship.json'), 'utf8'));
        expect(record.personaHash).toBe(personaHashFor('Nova', 'Nova has grown cold toward {{user}} and keeps her distance now.'));
        expect(relationships.nova).toBeDefined();
    });

    it('deletes an orphaned sidecar (a card file that is gone) on the judgment command', async () => {
        // A sidecar with no matching PNG: the card was deleted or renamed.
        fs.writeFileSync(path.join(tmpDir, 'ghost.user-relationship.json'), JSON.stringify({
            version: SIDECAR_VERSION,
            cardId: 'ghost',
            name: 'Ghost',
            personaHash: '0'.repeat(64),
            judgedAt: '2026-01-01T00:00:00.000Z',
            relationship: { label: 'ghost', summary: 'gone.' }
        }));
        expect(fs.existsSync(path.join(tmpDir, 'ghost.user-relationship.json'))).toBe(true);
        await controller.judgeCardUserRelationship('nova');
        expect(fs.existsSync(path.join(tmpDir, 'ghost.user-relationship.json'))).toBe(false);
        // The live sidecars survived the sweep.
        expect(fs.existsSync(path.join(tmpDir, 'nova.user-relationship.json'))).toBe(true);
    });

    // ------------------------------------------------------------ error paths
    it('rejects a card whose effective persona has no {{user}} token (422 shape)', async () => {
        await expect(controller.judgeCardUserRelationship('quiet'))
            .rejects.toThrow(CardUserTokenAbsentError);
        try {
            await controller.judgeCardUserRelationship('quiet');
        } catch (err) {
            expect(err.code).toBe('CARD_USER_TOKEN_ABSENT');
        }
        // No sidecar was written for a card that cannot be judged.
        expect(fs.existsSync(path.join(tmpDir, 'quiet.user-relationship.json'))).toBe(false);
    });

    it('rejects an unknown card id (404 shape) without an LLM call', async () => {
        llm.chatFull.mockClear();
        await expect(controller.judgeCardUserRelationship('no-such-card'))
            .rejects.toThrow(CardNotFoundError);
        expect(llm.chatFull).not.toHaveBeenCalled();
    });

    it('rejects a malformed card id before the LLM call (caller mistake -> 4xx)', async () => {
        llm.chatFull.mockClear();
        await expect(controller.judgeCardUserRelationship('a'.repeat(129)))
            .rejects.toThrow(RelationshipJudgmentError);
        expect(llm.chatFull).not.toHaveBeenCalled();
        await expect(controller.judgeCardUserRelationship(''))
            .rejects.toThrow(RelationshipJudgmentError);
    });

    it('propagates the LLM seam error untouched (the route maps it to 502)', async () => {
        const providerFailure = new LLMError('provider unreachable', 'LLM_UNAVAILABLE');
        llm.chatFull.mockRejectedValueOnce(providerFailure);
        await expect(controller.judgeCardUserRelationship('nova'))
            .rejects.toBe(providerFailure);
    });

    describe('answer validation (T-1, E-4)', () => {
        function answerWith(content) {
            llm.chatFull.mockReset();
            llm.chatFull.mockResolvedValueOnce({
                id: 'chatcmpl-fake',
                content,
                finishReason: 'stop',
                model: 'fake-model'
            });
        }

        it('rejects an answer that is not JSON, naming the violated rule', async () => {
            answerWith('I think the relationship is fairly close, honestly.');
            try {
                await controller.judgeCardUserRelationship('nova');
                throw new Error('expected a RelationshipJudgmentError');
            } catch (err) {
                expect(err).toBeInstanceOf(RelationshipJudgmentError);
                expect(err.errors[0]).toContain('did not parse');
            }
        });

        it('rejects an answer that is a JSON array, not an object', async () => {
            answerWith('["devoted partner", "one sentence"]');
            await expect(controller.judgeCardUserRelationship('nova'))
                .rejects.toThrow(/single JSON object/);
        });

        it('rejects an over-long label and an empty summary, naming both rules', async () => {
            answerWith(JSON.stringify({
                label: 'a'.repeat(RELATIONSHIP_LABEL_MAX_CHARS + 1),
                summary: '   '
            }));
            try {
                await controller.judgeCardUserRelationship('nova');
                throw new Error('expected a RelationshipJudgmentError');
            } catch (err) {
                expect(err).toBeInstanceOf(RelationshipJudgmentError);
                expect(err.errors.length).toBe(2);
                expect(err.errors.join('; ')).toContain(String(RELATIONSHIP_LABEL_MAX_CHARS));
                expect(err.errors.join('; ')).toContain('summary');
            }
        });

        it('rejects an over-long summary', async () => {
            answerWith(JSON.stringify({
                label: 'rival',
                summary: 'a'.repeat(RELATIONSHIP_SUMMARY_MAX_CHARS + 1)
            }));
            await expect(controller.judgeCardUserRelationship('nova'))
                .rejects.toThrow(new RegExp(String(RELATIONSHIP_SUMMARY_MAX_CHARS)));
        });

        it('tolerates a code fence around the JSON object (the model does it sometimes)', async () => {
            answerWith('```json\n' + JSON.stringify({ label: 'devoted partner', summary: 'She adores {{user}}.' }) + '\n```');
            const result = await controller.judgeCardUserRelationship('nova');
            expect(result.relationship.label).toBe('devoted partner');
        });

        it('trims the verdict before persisting it', async () => {
            answerWith(JSON.stringify({ label: '  devoted partner  ', summary: '  She adores {{user}}.  ' }));
            const result = await controller.judgeCardUserRelationship('nova');
            expect(result.relationship).toEqual({ label: 'devoted partner', summary: 'She adores {{user}}.' });
        });
    });
});
