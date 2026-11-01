/**
 * UNIT TEST — the mod HTTP surface around enable / disable / move.
 *
 * The contract the client depends on:
 *   - `POST /mods/:id/enable` and `POST /mods/:id/disable` answer
 *     `{ success: true, id, enabled, pending, appliesAt }` — the last two being the whole
 *     point: a queued change is not a failed one, and the response says when it lands.
 *   - `POST /mods/:id/move` reads `{ direction }` from the body and answers with the service's
 *     whole result, including `shadowChanged` — the keys whose owner the move reassigned, which
 *     is the only consequence of a reorder an operator can check.
 *   - A refusal carries the fields the service set (`mod`, `requires`, `from`, `to`) and no
 *     others: a route that invented them would describe a wire shape that does not exist.
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
        },
        moveMod: (id, direction) => {
            calls.push(['move', id, direction]);
            if (behavior?.throwOn) throw behavior.throwOn;
            return behavior?.result ?? {
                id, moved: true, direction, rank: 4, total: 22, loadOrder: 4000,
                previousLoadOrder: 5000, pending: true, appliesAt: 'next round boundary',
                shadowChanged: [], shadowChangedTruncated: false
            };
        }
    };
    return { service, calls };
}

async function withServer(deps) {
    const router = express.Router();
    register(router, deps);
    // The JSON body parser the real server installs (`src/utils/serverBootstrap.js`), because
    // `POST /mods/:id/move` reads `{ direction }` from the body. A harness without it would
    // pass a route test by reading `undefined` where the real server reads the request.
    const app = express().use(express.json()).use(router);
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

describe('POST /mods/:id/move', () => {
    beforeEach(() => { behavior = null; });

    /** A move refuses with fields, not only with a sentence. */
    const refusal = (message, code, fields) => Object.assign(
        new GameError(message, code),
        fields
    );

    it('sends the body direction to the service and answers with its whole result', async () => {
        const { service, calls } = makeStub();
        const { postJson, close } = await withServer({ modService: service });
        const { status, body } = await postJson('/mods/deep-geology/move', { direction: 'up' });
        expect(status).toBe(200);
        expect(calls).toEqual([['move', 'deep-geology', 'up']]);
        expect(body).toMatchObject({
            success: true,
            id: 'deep-geology',
            moved: true,
            direction: 'up',
            rank: 4,
            total: 22,
            pending: true,
            appliesAt: 'next round boundary',
            shadowChanged: [],
            shadowChangedTruncated: false
        });
        close();
    });

    it('names the keys the move reassigned, which is the whole point of the answer', async () => {
        behavior = {
            result: {
                id: 'x', moved: true, direction: 'down', rank: 1, total: 6, loadOrder: 1000,
                previousLoadOrder: 2000, pending: true, appliesAt: 'next round boundary',
                shadowChanged: [{ kind: 'components', key: 'knife', was: 'glyph', now: 'forge' }],
                shadowChangedTruncated: false
            }
        };
        const { service } = makeStub();
        const { postJson, close } = await withServer({ modService: service });
        const { status, body } = await postJson('/mods/x/move', { direction: 'down' });
        expect(status).toBe(200);
        expect(body.shadowChanged).toEqual([{ kind: 'components', key: 'knife', was: 'glyph', now: 'forge' }]);
        close();
    });

    it('answers 409 with the edge it hit, and no invented fields', async () => {
        behavior = { throwOn: new GameError('ModService: "x" is already at the top of the stack', 'MOD_MOVE_AT_EDGE') };
        const { service } = makeStub();
        const { postJson, close } = await withServer({ modService: service });
        const { status, body } = await postJson('/mods/x/move', { direction: 'up' });
        expect(status).toBe(409);
        expect(body).toMatchObject({ success: false, error: 'MOD_MOVE_AT_EDGE' });
        // The service set none of `mod`/`requires`/`from`/`to` here, so none of them appears.
        expect(body).not.toHaveProperty('requires');
        close();
    });

    it('answers 409 with the requires edge, the positions and the name', async () => {
        behavior = {
            throwOn: refusal(
                'ModService: cannot move "forge" up: it requires "atlas"',
                'MOD_MOVE_BREAKS_REQUIRES',
                { mod: 'forge', requires: 'atlas', from: 3, to: 2 }
            )
        };
        const { service } = makeStub();
        const { postJson, close } = await withServer({ modService: service });
        const { status, body } = await postJson('/mods/forge/move', { direction: 'up' });
        expect(status).toBe(409);
        expect(body).toMatchObject({
            success: false,
            error: 'MOD_MOVE_BREAKS_REQUIRES',
            mod: 'forge',
            requires: 'atlas',
            from: 3,
            to: 2
        });
        close();
    });

    it('answers 400 for a direction that is not up or down, and for no body at all', async () => {
        behavior = { throwOn: new GameError('ModService: move direction must be "up" or "down"', 'MOD_MOVE_DIRECTION_INVALID') };
        const { service, calls } = makeStub();
        const { postJson, post, close } = await withServer({ modService: service });
        const bad = await postJson('/mods/x/move', { direction: 'sideways' });
        expect(bad.status).toBe(400);
        // A POST with no body reaches the same refusal, because there is no direction to read.
        const empty = await post('/mods/x/move');
        expect(empty.status).toBe(400);
        expect(calls.map((c) => c[2])).toEqual(['sideways', undefined]);
        close();
    });

    it('keeps the shared 500 contract for anything the service did not code', async () => {
        behavior = { throwOn: new Error('disk on fire') };
        const { service } = makeStub();
        const { postJson, close } = await withServer({ modService: service });
        const { status, body } = await postJson('/mods/x/move', { direction: 'up' });
        expect(status).toBe(500);
        expect(body.error).toBe('Internal Server Error');
        close();
    });
});

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

describe('POST /mods/plan', () => {
    /** A service stub whose plan reports a refused package. */
    function makePlanStub(unsafeKeys) {
        const calls = [];
        const service = {
            plan: () => {
                calls.push(['plan']);
                return {
                    applied: false,
                    fromVersion: 7,
                    kinds: [],
                    quarantine: [],
                    shadowed: [],
                    invalid: [],
                    blocked: [],
                    unsafeKeys
                };
            }
        };
        return { service, calls };
    }

    it('carries the unsafe-key findings through the JSON envelope', async () => {
        const findings = [{
            modId: 'poison-parts',
            dir: 'poison-parts',
            kind: 'components',
            key: '__proto__',
            at: '$.evil.detail.__proto__'
        }];
        const { service, calls } = makePlanStub(findings);
        const { post, close } = await withServer({ modService: service });
        const { status, body } = await post('/mods/plan');

        expect(status).toBe(200);
        expect(calls).toEqual([['plan']]);
        // Worth pinning at the route: a non-serialisable value in this field (a Set, a
        // function) would disappear on the way out without failing anything server-side, and
        // the operator would read a clean plan.
        expect(body.plan.unsafeKeys).toEqual(findings);
        expect(body.plan.applied).toBe(false);
        close();
    });
});
