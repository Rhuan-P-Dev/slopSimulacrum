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
                cardId: 'minako',
                name: 'Minako',
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
                        cardId: 'minako',
                        name: 'Minako',
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
            new DesignValidationError('minako', ['bad structure', 'missing rationale'])
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
                body: JSON.stringify({ cardId: 'minako' })
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
                body: JSON.stringify({ cardId: 'minako' })
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
            card: { cardId: 'minako', name: 'Minako', description: 'x', personality: 'y' },
            body: { blueprintId: 'minakoRunner', rationale: 'fits her job', structure: { component: 'm1Head' }, components: [] },
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
                body: JSON.stringify({ cardId: 'minako' })
            });
            const body = await resp.json();
            expect(resp.status).toBe(200);
            expect(body).toEqual(design);
            expect(designer.designBody).toHaveBeenCalledTimes(1);
            expect(designer.designBody).toHaveBeenCalledWith('minako');
        } finally {
            server.close();
        }
    });
    // ------------------------------------------------------- POST /agent-body/save
    it('POST /agent-body/save with a valid design → 200 echoing the controller result', async () => {
        const saved = {
            saved: true,
            blueprintId: 'minakoRunner',
            newComponents: ['parcelStrap'],
            blueprintWritten: ['minakoRunner', 'm1CentralBody', 'm1Leg'],
            blueprintOverwritten: ['m1CentralBody', 'm1Leg'],
            backups: {
                components: 'data/mods/core-components/components.json.bak-1',
                blueprints: 'data/mods/core-blueprints/blueprints.json.bak-1'
            }
        };
        const { worldStateController } = makeDesignerStub({
            saveDesign: vi.fn(() => Promise.resolve(saved))
        });
        const app = buildApp({ worldStateController });
        const server = await new Promise((resolve) => {
            const s = app.listen(0);
            resolve(s);
        });
        try {
            const port = server.address().port;
            const design = {
                blueprintId: 'minakoRunner',
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
            expect(body).toEqual(saved);
            expect(worldStateController.agentBodyController.saveDesign).toHaveBeenCalledWith(design);
        } finally {
            server.close();
        }
    });

    it('POST /agent-body/save with a DesignValidationError → 422 with code + rule list', async () => {
        const { worldStateController } = makeDesignerStub({
            saveDesign: vi.fn(() => Promise.reject(
                new DesignValidationError('minakoRunner', ['missing rationale', 'bad structure'])
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
