/**
 * craftingRoutes unit tests.
 *
 * Pattern: express + Router + register() + app.listen(0) + fetch, with a
 * stubbed worldStateController (the facade is the only dependency the route
 * module takes; express.json() mirrors the production server middleware).
 *
 * Covers every row of the status-mapping table:
 *   GET  /crafting/recipes → 200 { recipes } / 500 { error, details }
 *   POST /crafting/:entityId/craft → 200 / 400 (fields & IDs & domain
 *        failures) / 404 (recipe/entity) / 500.
 *
 * @module test/unit/craftingRoutes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { register } from '../../src/routes/craftingRoutes.js';

const ENT = 'ent-0f8fad5b-d9cb-469f-a165-70867728755e';
const COMP = 'comp-1a2b3c4d-5e6f-7a8b-9c0d-1e2f3a4b5c6d';
const ITEM_A = 'item-aaaabbbb-cccc-dddd-eeee-ffff00001111';
const ITEM_B = 'item-22223333-4444-5555-6666-777788889999';

let server = null;

/**
 * Creates a fresh Express app with the crafting routes registered against
 * stubbed facade methods.
 * @param {Object} [overrides] - Optional stub-method overrides.
 * @returns {{ app: import('express').Express, craftItems: import('vitest').Mock, getCraftingRecipes: import('vitest').Mock }}
 */
function buildApp(overrides = {}) {
    const craftItems = overrides.craftItems ?? vi.fn(() => ({
        success: true,
        recipeId: 'knife_to_t1',
        consumed: [ITEM_A, ITEM_B],
        produced: [{ id: ITEM_A, type: 't1', hostComponentId: COMP, name: 'T1' }],
    }));
    const getCraftingRecipes = overrides.getCraftingRecipes ?? vi.fn(() => [
        {
            id: 'knife_to_t1',
            name: 'T1 Assembly',
            description: 'Fuse two knives into one T1 container weapon.',
            inputs: [{ type: 'knife', quantity: 2 }],
            outputs: [{ type: 't1', quantity: 1 }],
        },
    ]);

    const router = express.Router();
    register(router, { worldStateController: { craftItems, getCraftingRecipes } });

    const app = express();
    app.use(express.json());
    app.use(router);

    return { app, craftItems, getCraftingRecipes };
}

async function start(app) {
    const s = app.listen(0);
    await new Promise((resolve, reject) => {
        s.on('listening', resolve);
        s.on('error', reject);
    });
    return s;
}

beforeEach(() => {
    server = null;
});

afterEach(async () => {
    if (server) {
        await new Promise((resolve) => server.close(resolve));
        server = null;
    }
});

async function postCraft(body, path = `/crafting/${ENT}/craft`) {
    const res = await fetch(`http://localhost:${server.address().port}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
}

async function getRecipes() {
    const res = await fetch(`http://localhost:${server.address().port}/crafting/recipes`);
    return { status: res.status, body: await res.json() };
}

describe('craftingRoutes — GET /crafting/recipes', () => {
    it('returns 200 { recipes: [...] } from the facade', async () => {
        const { app, getCraftingRecipes } = buildApp();
        server = await start(app);

        const { status, body } = await getRecipes();
        expect(status).toBe(200);
        expect(getCraftingRecipes).toHaveBeenCalledTimes(1);
        expect(Array.isArray(body.recipes)).toBe(true);
        expect(body.recipes[0]).toMatchObject({ id: 'knife_to_t1', name: 'T1 Assembly' });
        expect(body.recipes[0].inputs).toEqual([{ type: 'knife', quantity: 2 }]);
        expect(body.recipes[0].outputs).toEqual([{ type: 't1', quantity: 1 }]);
    });

    it('returns 500 { error, details } on unexpected failure', async () => {
        const { app } = buildApp({
            getCraftingRecipes: vi.fn(() => {
                throw new Error('Simulated registry explosion');
            }),
        });
        server = await start(app);

        const { status, body } = await getRecipes();
        expect(status).toBe(500);
        expect(body.error).toBe('Internal Server Error');
        expect(body.details).toContain('Simulated registry explosion');
    });
});

describe('craftingRoutes — POST /crafting/:entityId/craft', () => {
    it('returns 200 { success, recipeId, consumed, produced } and forwards parsed args to the facade', async () => {
        const { app, craftItems } = buildApp();
        server = await start(app);

        const { status, body } = await postCraft({
            recipeId: 'knife_to_t1',
            componentId: COMP,
            itemIds: [ITEM_A, ITEM_B],
        });

        expect(status).toBe(200);
        expect(craftItems).toHaveBeenCalledWith(ENT, 'knife_to_t1', COMP, [ITEM_A, ITEM_B]);
        expect(body.success).toBe(true);
        expect(body.recipeId).toBe('knife_to_t1');
        expect(body.consumed).toEqual([ITEM_A, ITEM_B]);
        expect(body.produced).toHaveLength(1);
        expect(body.produced[0].type).toBe('t1');
    });

    it('returns 400 when recipeId is missing or not a string', async () => {
        const { app } = buildApp();
        server = await start(app);

        let { status, body } = await postCraft({ componentId: COMP, itemIds: [ITEM_A] });
        expect(status).toBe(400);
        expect(body.message).toContain('recipeId is required');

        ({ status, body } = await postCraft({ recipeId: 42, componentId: COMP, itemIds: [ITEM_A] }));
        expect(status).toBe(400);
        expect(body.message).toContain('recipeId is required');
    });

    it('returns 400 when componentId is missing', async () => {
        const { app } = buildApp();
        server = await start(app);

        const { status, body } = await postCraft({ recipeId: 'knife_to_t1', itemIds: [ITEM_A] });
        expect(status).toBe(400);
        expect(body.message).toContain('componentId is required');
    });

    it('returns 400 when itemIds is missing, not an array, or empty', async () => {
        const { app } = buildApp();
        server = await start(app);

        let { status, body } = await postCraft({ recipeId: 'knife_to_t1', componentId: COMP });
        expect(status).toBe(400);
        expect(body.message).toContain('itemIds');

        ({ status, body } = await postCraft({ recipeId: 'knife_to_t1', componentId: COMP, itemIds: 'item-abc' }));
        expect(status).toBe(400);
        expect(body.message).toContain('itemIds must be a non-empty array');

        ({ status, body } = await postCraft({ recipeId: 'knife_to_t1', componentId: COMP, itemIds: [] }));
        expect(status).toBe(400);
        expect(body.message).toContain('itemIds must be a non-empty array');
    });

    it('returns 400 with the exact IdResolver message for a bad entityId prefix', async () => {
        const { app, craftItems } = buildApp();
        server = await start(app);

        const { status, body } = await postCraft(
            { recipeId: 'knife_to_t1', componentId: COMP, itemIds: [ITEM_A] },
            '/crafting/not-an-entity/craft'
        );
        expect(status).toBe(400);
        expect(body.error).toBe('Invalid entityId in POST /crafting/:entityId/craft params: "not-an-entity". Expected typed ID format "ent-<uuid>".');
        expect(craftItems).not.toHaveBeenCalled();
    });

    it('returns 400 with the exact IdResolver message for a bad componentId prefix', async () => {
        const { app, craftItems } = buildApp();
        server = await start(app);

        const { status, body } = await postCraft({
            recipeId: 'knife_to_t1',
            componentId: 'item-0f8fad5b-d9cb-469f-a165-70867728755e',
            itemIds: [ITEM_A],
        });
        expect(status).toBe(400);
        expect(body.error).toBe('Invalid componentId in POST /crafting/:entityId/craft body: "item-0f8fad5b-d9cb-469f-a165-70867728755e". Expected typed ID format "comp-<uuid>".');
        expect(craftItems).not.toHaveBeenCalled();
    });

    it('returns 400 with the exact IdResolver message for a bad itemId prefix', async () => {
        const { app, craftItems } = buildApp();
        server = await start(app);

        const { status, body } = await postCraft({
            recipeId: 'knife_to_t1',
            componentId: COMP,
            itemIds: [ITEM_A, 'comp-0f8fad5b-d9cb-469f-a165-70867728755e'],
        });
        expect(status).toBe(400);
        expect(body.error).toBe('Invalid itemId in POST /crafting/:entityId/craft body: "comp-0f8fad5b-d9cb-469f-a165-70867728755e". Expected typed ID format "item-<uuid>".');
        expect(craftItems).not.toHaveBeenCalled();
    });

    it('maps RECIPE_NOT_FOUND and ENTITY_NOT_FOUND to 404', async () => {
        const { app } = buildApp({
            craftItems: vi.fn((entityId, recipeId) => {
                if (recipeId === 'nope') {
                    return { success: false, code: 'RECIPE_NOT_FOUND', message: 'Recipe "nope" not found.' };
                }
                return { success: false, code: 'ENTITY_NOT_FOUND', message: `Entity "${entityId}" not found.` };
            }),
        });
        server = await start(app);

        let { status, body } = await postCraft({ recipeId: 'nope', componentId: COMP, itemIds: [ITEM_A, ITEM_B] });
        expect(status).toBe(404);
        expect(body.error).toBe('Not Found');
        expect(body.message).toBe('Recipe "nope" not found.');

        ({ status, body } = await postCraft({ recipeId: 'knife_to_t1', componentId: COMP, itemIds: [ITEM_A, ITEM_B] }));
        expect(status).toBe(404);
        expect(body.error).toBe('Not Found');
        expect(body.message).toContain('not found');
    });

    it('maps each domain failure code to 400 { error: "Failed to craft", message }', async () => {
        const failures = {
            COMPONENT_NOT_FOUND: `Component "${COMP}" not found on entity "${ENT}".`,
            INVALID_ITEM: `Item "${ITEM_B}" is hosted on component "comp-other", not "${COMP}".`,
            INPUTS_MISMATCH: 'Craft inputs do not exactly match recipe "knife_to_t1": knife: have 1, need 2.',
            INSUFFICIENT_VOLUME: `Component ${COMP} has 0 free, gains 2, needs 6.`,
            CRAFT_FAILED: 'Failed to remove item-abc',
        };

        for (const [code, message] of Object.entries(failures)) {
            const { app } = buildApp({
                craftItems: vi.fn(() => ({ success: false, code, message })),
            });
            server = await start(app);

            const { status, body } = await postCraft({
                recipeId: 'knife_to_t1',
                componentId: COMP,
                itemIds: [ITEM_A, ITEM_B],
            });
            expect(status, code).toBe(400);
            expect(body.error, code).toBe('Failed to craft');
            expect(body.message, code).toBe(message);
        }
    });

    it('returns 500 { error, details } on an unexpected throw from the facade', async () => {
        const { app } = buildApp({
            craftItems: vi.fn(() => {
                throw new Error('Simulated stack-trace-worthy crash');
            }),
        });
        server = await start(app);

        const { status, body } = await postCraft({ recipeId: 'knife_to_t1', componentId: COMP, itemIds: [ITEM_A, ITEM_B] });
        expect(status).toBe(500);
        expect(body.error).toBe('Internal Server Error');
        expect(body.details).toContain('Simulated stack-trace-worthy crash');
    });
});
