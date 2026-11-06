/**
 * systemRoutes — unit tests (the System tab's HTTP surface).
 *
 * The authoring controller is stubbed (routes tested against a fake seam, `TST-2`), and
 * what is pinned is the wire contract: every error carries a machine-readable `code` in
 * the `{ error: { code, message } }` envelope (`CR H-2`), the 503 boot-order guard, and —
 * the property that matters most — that a write posts a SESSION ID and the route answers
 * where the package applies, never that the world changed.
 *
 * Request budgets: the route limiters are module-level (10 chat / 20 write per minute per
 * IP), so this file stays well under both. A 429 here would be a test-writing mistake, not
 * a finding.
 *
 * @module test/unit/systemRoutes
 */

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { LLMError, GameError } from '../../src/utils/CustomErrors.js';
import {
    SessionNotFoundError,
    ProposalNotSetError
} from '../../src/controllers/networking/WorldAuthoringController.js';
import { ProposalValidationError } from '../../src/services/WorldProposalValidator.js';
import { PACKAGE_WRITE_ERROR_CODES } from '../../src/services/ModPackageWriter.js';
import { register } from '../../src/routes/systemRoutes.js';

const proposalFixture = Object.freeze({
    kind: 'mod-proposal',
    packageId: 'system-salvage-plate',
    version: '1.0.0',
    description: 'A plate.',
    rationale: 'Because.',
    content: { components: { salvagePlate: { name: 'Salvage Plate' } } },
    added: [{ kind: 'components', key: 'salvagePlate' }],
    overrides: [],
    stats: { kinds: 1, definitions: 1 }
});

/**
 * Build an app over a stubbed facade + mod service.
 * @param {Object} authoring - stub controller (or null to test the 503 guard)
 * @param {Object} [modService] - stub package view
 */
function buildApp(authoring, modService = { rescan: vi.fn(() => ({ mods: [], invalid: [] })) }) {
    const worldStateController = {};
    if (authoring) worldStateController.worldAuthoringController = authoring;
    const router = express.Router();
    register(router, { worldStateController, modService });
    const app = express().use(express.json()).use(router);
    return { app, modService };
}

/** Serve on an ephemeral port and return the base URL plus the closer. */
async function serve(app) {
    const server = await new Promise((resolve) => resolve(app.listen(0)));
    return {
        base: `http://localhost:${server.address().port}`,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

/** POST and parse. */
async function postJson(base, path, body) {
    const resp = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    return { status: resp.status, body: await resp.json() };
}

describe('systemRoutes', () => {
    it('503 WORLD_AUTHORING_CONTROLLER_NOT_WIRED when the facade has no controller', async () => {
        const { app } = buildApp(null);
        const { base, close } = await serve(app);
        try {
            const resp = await fetch(`${base}/system/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: 'hello' })
            });
            expect(resp.status).toBe(503);
            expect(await resp.json()).toMatchObject({ error: { code: 'WORLD_AUTHORING_CONTROLLER_NOT_WIRED' } });
        } finally {
            await close();
        }
    });

    it('POST /system/chat answers the turn and names the prompt kind and version', async () => {
        const authoring = {
            handleChat: vi.fn(async ({ sessionId, message }) => ({
                sessionId: sessionId ?? 'ses-1',
                reply: `heard: ${message}`,
                proposal: proposalFixture,
                toolLog: [{ name: 'list_registries', ok: true, resultChars: 42 }],
                meta: { iterations: 2, model: 'test-model', systemPrompt: 'You are the System' }
            }))
        };
        const { app } = buildApp(authoring);
        const { base, close } = await serve(app);
        try {
            const { status, body } = await postJson(base, '/system/chat', { message: 'add a plate', sessionId: 'ses-1' });
            expect(status).toBe(200);
            expect(body).toMatchObject({
                sessionId: 'ses-1',
                reply: 'heard: add a plate',
                proposal: { packageId: 'system-salvage-plate' },
                toolLog: [{ name: 'list_registries', ok: true }],
                meta: { iterations: 2, promptKind: 'system-authoring' }
            });
            expect(authoring.handleChat).toHaveBeenCalledWith({ sessionId: 'ses-1', message: 'add a plate' });
        } finally {
            await close();
        }
    });

    it('POST /system/chat refuses a missing message and an over-long one, with codes', async () => {
        const authoring = { handleChat: vi.fn(async () => ({ sessionId: 's', reply: 'x', proposal: null, toolLog: [], meta: {} })) };
        const { app } = buildApp(authoring);
        const { base, close } = await serve(app);
        try {
            const missing = await postJson(base, '/system/chat', {});
            expect(missing.status).toBe(400);
            expect(missing.body.error.code).toBe('MESSAGE_REQUIRED');

            const tooLong = await postJson(base, '/system/chat', { message: 'x'.repeat(4001) });
            expect(tooLong.status).toBe(400);
            expect(tooLong.body.error.code).toBe('MESSAGE_TOO_LONG');
            expect(authoring.handleChat).not.toHaveBeenCalled();
        } finally {
            await close();
        }
    });

    it('POST /system/chat maps a provider failure to 502 with the seam code', async () => {
        const authoring = {
            handleChat: vi.fn(async () => { throw new LLMError('provider down', 'LLM_TIMEOUT'); })
        };
        const { app } = buildApp(authoring);
        const { base, close } = await serve(app);
        try {
            const { status, body } = await postJson(base, '/system/chat', { message: 'hello' });
            expect(status).toBe(502);
            expect(body.error).toMatchObject({ code: 'LLM_TIMEOUT' });
            // The provider's own sentence does not travel to the client (`E-4`, `E-7`).
            expect(body.error.message).not.toContain('provider down');
        } finally {
            await close();
        }
    });

    it('GET /system/history/:sessionId answers, and 404s for an unknown session', async () => {
        const authoring = {
            getHistory: vi.fn((id) => {
                if (id === 'unknown') throw new SessionNotFoundError(id);
                return { sessionId: id, messages: [{ role: 'user', content: 'hi' }], proposal: proposalFixture, updatedAt: '2026-01-01T00:00:00.000Z' };
            })
        };
        const { app } = buildApp(authoring);
        const { base, close } = await serve(app);
        try {
            const ok = await fetch(`${base}/system/history/ses-9`);
            expect(ok.status).toBe(200);
            expect(await ok.json()).toMatchObject({ sessionId: 'ses-9', proposal: { packageId: 'system-salvage-plate' } });

            const missing = await fetch(`${base}/system/history/unknown`);
            expect(missing.status).toBe(404);
            expect((await missing.json()).error.code).toBe('SESSION_NOT_FOUND');
        } finally {
            await close();
        }
    });

    it('POST /system/write posts a session id only, and answers that applying is elsewhere', async () => {
        const writeProposal = vi.fn(async () => ({
            saved: true,
            packageId: 'system-salvage-plate',
            dir: 'data/mods/system-salvage-plate',
            files: ['data/mods/system-salvage-plate/mod.json'],
            content: ['components'],
            created: true,
            overwritten: [],
            backups: [],
            added: [{ kind: 'components', key: 'salvagePlate' }],
            overrides: []
        }));
        const authoring = { writeProposal };
        const modService = { rescan: vi.fn(() => ({ mods: [{ manifest: { id: 'system-salvage-plate' } }], invalid: [] })) };
        const { app } = buildApp(authoring, modService);
        const { base, close } = await serve(app);
        try {
            const { status, body } = await postJson(base, '/system/write', { sessionId: 'ses-1' });
            expect(status).toBe(200);
            expect(writeProposal).toHaveBeenCalledWith('ses-1');
            expect(body).toMatchObject({
                saved: true,
                packageId: 'system-salvage-plate',
                applied: false,
                appliesVia: 'POST /mods/apply',
                scanned: { installed: 1, rejected: 0 }
            });
            expect(modService.rescan).toHaveBeenCalledTimes(1);
        } finally {
            await close();
        }
    });

    it('POST /system/write answers the typed refusals: no id, unknown session, nothing proposed', async () => {
        const authoring = {
            writeProposal: vi.fn(async (id) => {
                if (id === 'gone') throw new SessionNotFoundError(id);
                throw new ProposalNotSetError(id);
            })
        };
        const { app } = buildApp(authoring);
        const { base, close } = await serve(app);
        try {
            const noId = await postJson(base, '/system/write', {});
            expect(noId.status).toBe(400);
            expect(noId.body.error.code).toBe('WRITE_PAYLOAD_INVALID');

            const gone = await postJson(base, '/system/write', { sessionId: 'gone' });
            expect(gone.status).toBe(404);
            expect(gone.body.error.code).toBe('SESSION_NOT_FOUND');

            const nothing = await postJson(base, '/system/write', { sessionId: 'ses-1' });
            expect(nothing.status).toBe(409);
            expect(nothing.body.error.code).toBe('PROPOSAL_NOT_SET');
        } finally {
            await close();
        }
    });

    it('POST /system/write maps a validation failure and a writer refusal to 422 with their codes', async () => {
        const authoring = {
            writeProposal: vi.fn()
                .mockRejectedValueOnce(new ProposalValidationError(['"rooms" is world structure']))
                .mockRejectedValueOnce(new GameError('too large', PACKAGE_WRITE_ERROR_CODES.TOO_LARGE))
        };
        const { app } = buildApp(authoring);
        const { base, close } = await serve(app);
        try {
            const invalid = await postJson(base, '/system/write', { sessionId: 'ses-1' });
            expect(invalid.status).toBe(422);
            expect(invalid.body.error.code).toBe('PROPOSAL_INVALID');
            expect(invalid.body.error.fields).toEqual(['"rooms" is world structure']);

            const refused = await postJson(base, '/system/write', { sessionId: 'ses-1' });
            expect(refused.status).toBe(422);
            expect(refused.body.error.code).toBe(PACKAGE_WRITE_ERROR_CODES.TOO_LARGE);
        } finally {
            await close();
        }
    });
});
