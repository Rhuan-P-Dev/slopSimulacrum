/**
 * UNIT TEST — the mod HTTP surface around enable / disable.
 *
 * The contract the client depends on:
 *   - `POST /mods/:id/enable` and `POST /mods/:id/disable` answer
 *     `{ success: true, id, enabled, pending, appliesAt }` — the last two being the whole
 *     point: a queued change is not a failed one, and the response says when it lands.
 *   - A package that is not installed is a 404 with the domain code, not a 500 and not a
 *     silently created state entry.
 *   - An unexpected failure keeps the shared 500 contract (`{ error, details }`).
 *
 * The service is a stub: the routes' job is mapping a request to one service call and the
 * service's answer to a status, and nothing here should depend on the world.
 *
 * @module test/unit/modRoutes
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { register } from '../../src/routes/modRoutes.js';
import { GameError } from '../../src/utils/CustomErrors.js';

/** @type {Object} the stub the routes call; each test sets what it should return or throw. */
let behavior;

function makeStub() {
    const calls = [];
    const service = {
        enable: (id) => {
            calls.push(['enable', id]);
            if (behavior?.throwOn) throw behavior.throwOn;
            return behavior?.result ?? { id, enabled: true, pending: true, appliesAt: 'next round boundary' };
        },
        disable: (id) => {
            calls.push(['disable', id]);
            if (behavior?.throwOn) throw behavior.throwOn;
            return behavior?.result ?? { id, enabled: false, pending: true, appliesAt: 'next round boundary' };
        }
    };
    return { service, calls };
}

async function withServer(deps) {
    const router = express.Router();
    register(router, deps);
    const app = express().use(router);
    const server = await new Promise((resolve) => resolve(app.listen(0)));
    const port = server.address().port;
    return {
        post: async (path) => {
            const res = await fetch(`http://localhost:${port}${path}`, { method: 'POST' });
            return { status: res.status, body: await res.json() };
        },
        get: async (path) => {
            const res = await fetch(`http://localhost:${port}${path}`);
            return { status: res.status, body: await res.json() };
        },
        postJson: async (path, payload) => {
            const res = await fetch(`http://localhost:${port}${path}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            return { status: res.status, body: await res.json() };
        },
        close: () => server.close()
    };
}

describe('POST /mods/:id/enable and /disable', () => {
    beforeEach(() => { behavior = null; });

    it('enables a package and says when it takes effect', async () => {
        const { service, calls } = makeStub();
        const { post, close } = await withServer({ modService: service });
        const { status, body } = await post('/mods/deep-geology/enable');
        expect(status).toBe(200);
        expect(body).toEqual({
            success: true,
            id: 'deep-geology',
            enabled: true,
            pending: true,
            appliesAt: 'next round boundary'
        });
        expect(calls).toEqual([['enable', 'deep-geology']]);
        close();
    });

    it('disables a package through the same envelope', async () => {
        const { service, calls } = makeStub();
        const { post, close } = await withServer({ modService: service });
        const { status, body } = await post('/mods/deep-geology/disable');
        expect(status).toBe(200);
        expect(body.success).toBe(true);
        expect(body.enabled).toBe(false);
        expect(calls).toEqual([['disable', 'deep-geology']]);
        close();
    });

    it('reports a package that is not installed as 404 with its domain code', async () => {
        behavior = { throwOn: new GameError('ModService: no mod package named "nope" is installed', 'MOD_NOT_FOUND') };
        const { service } = makeStub();
        const { post, close } = await withServer({ modService: service });
        const { status, body } = await post('/mods/nope/disable');
        expect(status).toBe(404);
        // The shared contract adds `details` outside production; the route owns the rest.
        expect(body).toMatchObject({
            success: false,
            error: 'MOD_NOT_FOUND',
            message: 'ModService: no mod package named "nope" is installed'
        });
        expect(body.details).toBe('ModService: no mod package named "nope" is installed');
        close();
    });

    it('reports a malformed id as 400', async () => {
        behavior = { throwOn: new GameError('ModService: mod id must be a non-empty string', 'MOD_ID_INVALID') };
        const { service } = makeStub();
        const { post, close } = await withServer({ modService: service });
        const { status, body } = await post('/mods/x/enable');
        expect(status).toBe(400);
        expect(body.error).toBe('MOD_ID_INVALID');
        close();
    });

    it('refuses to remove a package the world still references, with 409', async () => {
        behavior = {
            throwOn: new GameError(
                'ModService: cannot disable "core-materials": core-components requires it - disable those first',
                'MOD_REQUIREMENT_HELD'
            )
        };
        const { service } = makeStub();
        const { post, close } = await withServer({ modService: service });
        const { status, body } = await post('/mods/core-materials/disable');
        // 409, not 400: the request is fine, the install is what objects. The body names who
        // blocks it, which is the whole instruction the operator needs.
        expect(status).toBe(409);
        expect(body.error).toBe('MOD_REQUIREMENT_HELD');
        expect(body.message).toContain('core-components');
        close();
    });

    it('refuses an enable whose own requirement is unmet, with 409', async () => {
        behavior = {
            throwOn: new GameError('ModService: cannot enable "addon": requires "core-base", which is disabled', 'MOD_REQUIREMENT_UNMET')
        };
        const { service } = makeStub();
        const { post, close } = await withServer({ modService: service });
        const { status, body } = await post('/mods/addon/enable');
        expect(status).toBe(409);
        expect(body.error).toBe('MOD_REQUIREMENT_UNMET');
        close();
    });

    it('keeps the shared 500 contract for a failure it does not understand', async () => {
        behavior = { throwOn: new Error('disk is gone') };
        const { service } = makeStub();
        const { post, close } = await withServer({ modService: service });
        const { status, body } = await post('/mods/any-mod/enable');
        expect(status).toBe(500);
        expect(body.error).toBe('Internal Server Error');
        expect(body.details).toBe('disk is gone');
        close();
    });
});

/**
 * `POST /mods/apply` and `GET /mods/:id/files`.
 *
 * The apply contract is the one a human clicks, so it is worth pinning: the route
 * forwards the service's answer unchanged, and `applied: false` with an
 * `appliesAt` is a deferral the client must be able to show. A 200 with a body
 * that only says `ok` would hide the difference between "the world changed" and
 * "a round is open, be patient", which is the difference the round boundary
 * exists to make.
 */
describe('POST /mods/apply and GET /mods/:id/files', () => {
    /** A service stub whose apply / files answers each test sets. */
    function makeApplyStub() {
        const calls = [];
        return {
            calls,
            service: {
                requestApply: () => {
                    calls.push(['requestApply']);
                    if (behavior?.applyThrows) throw behavior.applyThrows;
                    return behavior?.applyResult ?? { applied: false, pending: true, appliesAt: 'next round boundary', reason: 'ROUND_ACTIVE' };
                },
                packageFiles: (id) => {
                    calls.push(['packageFiles', id]);
                    if (behavior?.filesThrows) throw behavior.filesThrows;
                    return behavior?.filesResult ?? { id, dir: `data/mods/${id}`, manifest: { id }, files: [] };
                }
            }
        };
    }

    beforeEach(() => { behavior = null; });

    it('answers a deferred apply with the moment it will land, not with a failure', async () => {
        const { service, calls } = makeApplyStub();
        const { post, close } = await withServer({ modService: service });
        const { status, body } = await post('/mods/apply');
        expect(status).toBe(200);
        expect(body).toEqual({
            success: true, applied: false, pending: true, appliesAt: 'next round boundary', reason: 'ROUND_ACTIVE'
        });
        expect(calls).toEqual([['requestApply']]);
        close();
    });

    it('answers an immediate apply with the swap report', async () => {
        behavior = {
            applyResult: {
                applied: true, pending: false, appliesAt: 'immediate',
                report: { ok: true, version: 4, swappedKinds: ['materials'], quarantined: [], mods: 21 }
            }
        };
        const { service } = makeApplyStub();
        const { post, close } = await withServer({ modService: service });
        const { status, body } = await post('/mods/apply');
        expect(status).toBe(200);
        expect(body.applied).toBe(true);
        expect(body.report.version).toBe(4);
        expect(body.report.swappedKinds).toEqual(['materials']);
        close();
    });

    it('maps a candidate the world will not take to 409, with the code', async () => {
        behavior = { applyThrows: new GameError('candidate is not installable', 'REGISTRY_CANDIDATE_INVALID') };
        const { service } = makeApplyStub();
        const { post, close } = await withServer({ modService: service });
        const { status, body } = await post('/mods/apply');
        expect(status).toBe(409);
        expect(body.error).toBe('REGISTRY_CANDIDATE_INVALID');
        close();
    });

    it('lists a package\'s own files', async () => {
        behavior = {
            filesResult: {
                id: 'core-materials',
                dir: 'data/mods/core-materials',
                manifest: { id: 'core-materials', version: '1.0.0', content: ['materials'] },
                files: [
                    { name: 'materials.json', json: true, kind: 'materials', content: { steel: {} } },
                    { name: 'mod.json', json: true, kind: null, content: { id: 'core-materials' } }
                ]
            }
        };
        const { service, calls } = makeApplyStub();
        const { get, close } = await withServer({ modService: service });
        const { status, body } = await get('/mods/core-materials/files');
        expect(status).toBe(200);
        expect(body.dir).toBe('data/mods/core-materials');
        expect(body.files.map((f) => [f.name, f.kind])).toEqual([['materials.json', 'materials'], ['mod.json', null]]);
        expect(calls).toEqual([['packageFiles', 'core-materials']]);
        close();
    });

    it('404s the files of a package that is not installed', async () => {
        behavior = { filesThrows: new GameError('ModService: no mod package named "nope" is installed', 'MOD_NOT_FOUND') };
        const { service } = makeApplyStub();
        const { get, close } = await withServer({ modService: service });
        const { status, body } = await get('/mods/nope/files');
        expect(status).toBe(404);
        expect(body.error).toBe('MOD_NOT_FOUND');
        close();
    });
});
