/**
 * agentBodyRoutes — unit tests (Feature A, "Create Agent Body" dev tab).
 *
 * The designer is stubbed (routes are tested against the fake seam per
 * TST-2; real-provider behavior is the live smoke test). Covers every error
 * envelope shape (CR H-1/H-2 — machine-readable `code` in `{ error: { code,
 * message } }`) and the 503 boot-order guard.
 *
 * @module test/unit/agentBodyRoutes
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import express from 'express';
import { LLMError } from '../../src/utils/CustomErrors.js';
import {
    CardNotFoundError,
    DesignValidationError
} from '../../src/controllers/networking/AgentBodyController.js';
import { register } from '../../src/routes/agentBodyRoutes.js';

/**
 * A stub of the designer facade attachment (same shape the routes read).
 */
function makeDesignerStub(options = {}) {
    const designer = {
        listCards: vi.fn(() => [
            {
                cardId: 'nova',
                name: 'Nova',
                description: 'small fox courier',
                personality: 'helpful'
            }
        ]),
        designBody: vi.fn()
    };
    Object.assign(designer, options);
    return { worldStateController: { agentBodyController: designer }, designer };
}

function buildApp(deps) {
    const router = express.Router();
    register(router, deps);
    return express()
        .use(express.json())
        .use(router);
}

afterAll(() => {
    // Nothing to clean up: every helper below listens on an ephemeral port
    // and closes inside its `it` block.
});

describe('agentBodyRoutes', () => {
    // ------------------------------------------------------- GET /agent-body/cards
    it('GET /agent-body/cards → 200 with { cards } from the controller', async () => {
        const { worldStateController } = makeDesignerStub();
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/cards`);
            const body = await resp.json();
            expect(resp.status).toBe(200);
            expect(body).toEqual({
                cards: [
                    {
                        cardId: 'nova',
                        name: 'Nova',
                        description: 'small fox courier',
                        personality: 'helpful'
                    }
                ]
            });
        } finally {
            server.close();
        }
    });

    it('GET /agent-body/cards → 503 with AGENT_BODY_CONTROLLER_NOT_WIRED when the controller is absent', async () => {
        const app = buildApp({ worldStateController: {} });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/cards`);
            const body = await resp.json();
            expect(resp.status).toBe(503);
            expect(body.error).toEqual({
                code: 'AGENT_BODY_CONTROLLER_NOT_WIRED',
                message: 'The agent body controller is not wired to this server'
            });
        } finally {
            server.close();
        }
    });

    // ------------------------------------------------ GET /agent-body/cards/:cardId/image
    it('GET /agent-body/cards/:cardId/image → 200 with the bytes, the controller\'s content type and no-store', async () => {
        const bytes = Buffer.from('\x89PNG fake bytes');
        const { worldStateController, designer } = makeDesignerStub({
            readCardImage: vi.fn(() => ({ bytes, mimeType: 'image/png' }))
        });
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/cards/nova/image`);
            const body = Buffer.from(await resp.arrayBuffer());
            expect(resp.status).toBe(200);
            expect(resp.headers.get('content-type')).toBe('image/png');
            expect(resp.headers.get('content-length')).toBe(String(bytes.length));
            expect(resp.headers.get('cache-control')).toBe('no-store');
            expect(body.equals(bytes)).toBe(true);
            expect(designer.readCardImage).toHaveBeenCalledWith('nova');
        } finally {
            server.close();
        }
    });

    it('GET /agent-body/cards/:cardId/image → 404 CARD_NOT_FOUND when no card file matches', async () => {
        const { worldStateController } = makeDesignerStub({
            readCardImage: vi.fn(() => {
                throw new CardNotFoundError('no-such-card');
            })
        });
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/cards/no-such-card/image`);
            const body = await resp.json();
            expect(resp.status).toBe(404);
            expect(body.error.code).toBe('CARD_NOT_FOUND');
        } finally {
            server.close();
        }
    });

    it('GET /agent-body/cards/:cardId/image → 400 CARD_ID_REQUIRED when the segment is over the length bound', async () => {
        const { worldStateController, designer } = makeDesignerStub({
            readCardImage: vi.fn()
        });
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const tooLong = 'a'.repeat(129);
            const resp = await fetch(`http://localhost:${port}/agent-body/cards/${tooLong}/image`);
            const body = await resp.json();
            expect(resp.status).toBe(400);
            expect(body.error.code).toBe('CARD_ID_REQUIRED');
            expect(designer.readCardImage).not.toHaveBeenCalled();
        } finally {
            server.close();
        }
    });

    it('GET /agent-body/cards/:cardId/image → 503 AGENT_BODY_CONTROLLER_NOT_WIRED when the controller is absent', async () => {
        const app = buildApp({ worldStateController: {} });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/cards/nova/image`);
            const body = await resp.json();
            expect(resp.status).toBe(503);
            expect(body.error.code).toBe('AGENT_BODY_CONTROLLER_NOT_WIRED');
        } finally {
            server.close();
        }
    });

    it('GET /agent-body/cards/:cardId/image → 500 (route contract) when the read fails and is not a CardNotFoundError', async () => {
        // A read failure that is not a missing card (e.g. the disk) is a 500
        // with the shared route contract, never a coded 4xx: the controller
        // threw something other than CardNotFoundError, so the endpoint falls
        // through to sendRouteError.
        const { worldStateController } = makeDesignerStub({
            readCardImage: vi.fn(() => {
                throw new Error('disk exploded');
            })
        });
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/cards/nova/image`);
            const body = await resp.json();
            expect(resp.status).toBe(500);
            expect(body.error).toBe('Internal Server Error');
            // The detail (the exception message) is exposed outside production
            // (the routeError contract); vitest runs with NODE_ENV=test.
            if (process.env.NODE_ENV !== 'production') {
                expect(body.details).toContain('disk exploded');
            }
        } finally {
            server.close();
        }
    });

    // ----------------------------------------------------- POST /agent-body/create
    it('POST /agent-body/create → 400 CARD_ID_REQUIRED without a cardId in the body', async () => {
        const { worldStateController } = makeDesignerStub();
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({})
            });
            const body = await resp.json();
            expect(resp.status).toBe(400);
            expect(body.error.code).toBe('CARD_ID_REQUIRED');
        } finally {
            server.close();
        }
    });

    it('POST /agent-body/create → 404 CARD_NOT_FOUND when no card PNG matches', async () => {
        const { worldStateController, designer } = makeDesignerStub();
        designer.designBody.mockRejectedValueOnce(new CardNotFoundError('no-such-card'));
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cardId: 'no-such-card' })
            });
            const body = await resp.json();
            expect(resp.status).toBe(404);
            expect(body.error.code).toBe('CARD_NOT_FOUND');
        } finally {
            server.close();
        }
    });

    it('POST /agent-body/create → 422 BODY_DESIGN_INVALID with the rule list in the message', async () => {
        const { worldStateController, designer } = makeDesignerStub();
        designer.designBody.mockRejectedValueOnce(
            new DesignValidationError('nova', ['bad structure', 'missing rationale'])
        );
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cardId: 'nova' })
            });
            const body = await resp.json();
            expect(resp.status).toBe(422);
            expect(body.error.code).toBe('BODY_DESIGN_INVALID');
            expect(body.error.message).toBe(
                "The model's design failed validation for this card: bad structure; missing rationale"
            );
        } finally {
            server.close();
        }
    });

    it('POST /agent-body/create → 502 with the LLM code when the seam throws LLMError', async () => {
        const { worldStateController, designer } = makeDesignerStub();
        designer.designBody.mockRejectedValueOnce(
            new LLMError('LLM request timed out after 3000000ms', 'LLM_TIMEOUT')
        );
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cardId: 'nova' })
            });
            const body = await resp.json();
            expect(resp.status).toBe(502);
            expect(body.error.code).toBe('LLM_TIMEOUT');
        } finally {
            server.close();
        }
    });

    it('POST /agent-body/create → 200 echoing { card, body, meta } on success', async () => {
        const { worldStateController, designer } = makeDesignerStub();
        const design = {
            card: { cardId: 'nova', name: 'Nova', description: 'x', personality: 'y' },
            body: { blueprintId: 'novaRunner', rationale: 'fits her job', structure: { component: 'm1Head' }, components: [] },
            meta: { promptKind: 'agent-body-design', promptVersion: '1.0.0', model: 'test-model', finishReason: 'stop', latencyMs: 1200 }
        };
        designer.designBody.mockResolvedValueOnce(design);
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/create`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cardId: 'nova' })
            });
            const body = await resp.json();
            expect(resp.status).toBe(200);
            expect(body).toEqual(design);
            expect(designer.designBody).toHaveBeenCalledTimes(1);
            expect(designer.designBody).toHaveBeenCalledWith('nova');
        } finally {
            server.close();
        }
    });
    // ------------------------------------------------------- POST /agent-body/save
    it('POST /agent-body/save with a valid design → 200 with the package report, applied: false', async () => {
        const saved = {
            saved: true,
            packageId: 'body-novarunner',
            dir: 'data/mods/body-novarunner',
            version: '1.0.0',
            created: true,
            content: ['components', 'blueprints'],
            files: ['data/mods/body-novarunner/components.json', 'data/mods/body-novarunner/blueprints.json'],
            overwritten: [],
            backups: [],
            blueprintId: 'novaRunner',
            newComponents: ['parcelStrap'],
            newItems: [],
            outfitWritten: false,
            blueprintWritten: ['novaRunner', 'm1CentralBody', 'm1Leg'],
            overlapsOfficial: [{ kind: 'blueprints', key: 'm1CentralBody' }]
        };
        const rescan = vi.fn(() => ({ mods: [{ id: 'body-novarunner' }, { id: 'core-world' }, { id: 'core-npcs' }], invalid: [] }));
        const { worldStateController } = makeDesignerStub({
            saveDesign: vi.fn(() => Promise.resolve(saved))
        });
        const app = buildApp({ worldStateController, modService: { rescan } });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const design = {
                blueprintId: 'novaRunner',
                rationale: 'Save this droid.',
                structure: { component: 'm1CentralBody' }
            };
            const resp = await fetch(`http://localhost:${port}/agent-body/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(design)
            });
            const body = await resp.json();
            expect(resp.status).toBe(200);
            // The controller's report, plus the two fields the route owns: writing a
            // package is not applying it, and the mods view was refreshed so the new row
            // is visible without another click.
            expect(body).toEqual({
                ...saved,
                applied: false,
                appliesVia: 'POST /mods/apply',
                scanned: { installed: 3, rejected: 0 }
            });
            expect(worldStateController.agentBodyController.saveDesign).toHaveBeenCalledWith(design);
            expect(rescan).toHaveBeenCalledTimes(1);
        } finally {
            server.close();
        }
    });

    it('POST /agent-body/save when the writer refuses the package → 422 with the MOD_PACKAGE code', async () => {
        const writerError = new Error('ModPackageWriter: package "body-x" would write 300000 bytes, over the 200000 limit');
        writerError.code = 'MOD_PACKAGE_TOO_LARGE';
        const { worldStateController } = makeDesignerStub({
            saveDesign: vi.fn(() => Promise.reject(writerError))
        });
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ blueprintId: 'x', rationale: 'r', structure: { component: 'm1CentralBody' } })
            });
            const body = await resp.json();
            expect(resp.status).toBe(422);
            expect(body.error.code).toBe('MOD_PACKAGE_TOO_LARGE');
        } finally {
            server.close();
        }
    });

    it('POST /agent-body/save with a DesignValidationError → 422 with code + rule list', async () => {
        const { worldStateController } = makeDesignerStub({
            saveDesign: vi.fn(() => Promise.reject(
                new DesignValidationError('novaRunner', ['missing rationale', 'bad structure'])
            ))
        });
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ blueprintId: 'x', rationale: '', structure: { component: 'a' } })
            });
            const body = await resp.json();
            expect(resp.status).toBe(422);
            expect(body.error.code).toBe('BODY_DESIGN_INVALID');
            expect(body.error.message).toBe('The saved design failed validation: missing rationale; bad structure');
        } finally {
            server.close();
        }
    });

    it('POST /agent-body/save when the controller is unwired → 503 AGENT_BODY_CONTROLLER_NOT_WIRED', async () => {
        const app = buildApp({ worldStateController: { agentBodyController: null } });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ blueprintId: 'x', rationale: 'r', structure: { component: 'a' } })
            });
            const body = await resp.json();
            expect(resp.status).toBe(503);
            expect(body.error.code).toBe('AGENT_BODY_CONTROLLER_NOT_WIRED');
        } finally {
            server.close();
        }
    });

    it('POST /agent-body/save with a non-object body → 400 SAVE_PAYLOAD_INVALID', async () => {
        const { worldStateController } = makeDesignerStub({ saveDesign: vi.fn() });
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([1, 2, 3])
            });
            const body = await resp.json();
            expect(resp.status).toBe(400);
            expect(body.error.code).toBe('SAVE_PAYLOAD_INVALID');
        } finally {
            server.close();
        }
    });

    it('POST /agent-body/save when saveDesign throws a non-design error → 500', async () => {
        const { worldStateController } = makeDesignerStub({
            saveDesign: vi.fn(() => Promise.reject(new Error('disk full')))
        });
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const resp = await fetch(`http://localhost:${port}/agent-body/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ blueprintId: 'x', rationale: 'r', structure: { component: 'a' } })
            });
            expect(resp.status).toBe(500);
        } finally {
            server.close();
        }
    });
});
