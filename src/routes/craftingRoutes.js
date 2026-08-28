/**
 * Crafting API Routes
 *
 * Endpoints for the crafting UI panel (a pure UI-panel feature: no world
 * entity, no range/spatial validation, no turn consumed — see the crafting
 * design spec, docs/crafting_design_spec.md §2.3/§2.4):
 *
 *   GET  /crafting/recipes          → { recipes: [...] } (defensive copies)
 *   POST /crafting/:entityId/craft  → { success, recipeId, consumed, produced }
 *
 * All business logic lives in the WorldStateController facade
 * (`craftItems` / `getCraftingRecipes`); this module is HTTP plumbing only:
 * typed-ID validation, field checks, and status-code mapping.
 *
 * @module routes/craftingRoutes
 */
import Logger from '../utils/Logger.js';
import IdResolver from '../utils/IdResolver.js';

// TYPED ID MIGRATION: Typed ID validation helper functions
// (same style as inventoryRoutes.js — route modules are independent,
// so helpers are local per module, no cross-route imports).
/**
 * Validates that an ID is a typed entity ID (ent-uuid).
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateEntityId(id, context) {
    if (!IdResolver.isEntityId(id)) {
        return { valid: false, error: `Invalid entityId in ${context}: "${id}". Expected typed ID format "ent-<uuid>".` };
    }
    return { valid: true };
}

/**
 * Validates that an ID is a typed component ID (comp-uuid).
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateCompId(id, context) {
    if (!IdResolver.isCompId(id)) {
        return { valid: false, error: `Invalid componentId in ${context}: "${id}". Expected typed ID format "comp-<uuid>".` };
    }
    return { valid: true };
}

/**
 * Validates that an ID is a typed item ID (item-uuid).
 * Returns { valid: true } or { valid: false, error: string }.
 */
function validateItemId(id, context) {
    if (!IdResolver.isItemId(id)) {
        return { valid: false, error: `Invalid itemId in ${context}: "${id}". Expected typed ID format "item-<uuid>".` };
    }
    return { valid: true };
}

/**
 * Registers crafting-related routes with the given Express router.
 * @param {import('express').Router} router - Express router instance
 * @param {Object} deps - Dependencies
 * @param {Object} deps.worldStateController - World state controller instance
 */
export function register(router, { worldStateController }) {
	// =========================================================
	// STATIC ROUTES — MUST be registered BEFORE parameterized routes
	// Express matches routes in order; parameterized routes like
	// /:entityId would intercept static paths if registered first.
	// =========================================================

	/**
	 * GET /crafting/recipes
	 * Returns all crafting recipe definitions (defensive deep copies, as an
	 * array). Display names/icons for the item types are resolved
	 * client-side from GET /inventory/registry (single source of truth).
	 */
	router.get('/crafting/recipes', (req, res) => {
		try {
			const recipes = worldStateController.getCraftingRecipes();
			res.json({ recipes });
		} catch (error) {
			Logger.error('/crafting/recipes endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});

	// =========================================================
	// PARAMETERIZED ROUTES — registered AFTER static routes
	// =========================================================

	/**
	 * POST /crafting/:entityId/craft
	 * Crafts a recipe: consumes the listed item instances from the component
	 * and produces the recipe's outputs on the SAME component.
	 * Body: { recipeId: string, componentId: string (comp-<uuid>),
	 *         itemIds: string[] (item-<uuid> each) }
	 *
	 * Status mapping:
	 *   200 { success: true, recipeId, consumed, produced }
	 *   400 { error: 'Bad Request' | 'Failed to craft', message }
	 *       (missing/malformed fields, bad ID prefixes, component not on
	 *        entity, item not hosted on the component, multiset mismatch,
	 *        insufficient volume)
	 *   404 { error: 'Not Found', message } (unknown recipe or entity)
	 *   500 { error: 'Internal Server Error', details } (unexpected throw)
	 */
	router.post('/crafting/:entityId/craft', (req, res) => {
		try {
			const { entityId } = req.params;
			const { recipeId, componentId, itemIds } = req.body || {};

			// TYPED ID MIGRATION: Validate entityId format
			const entityIdValidation = validateEntityId(entityId, 'POST /crafting/:entityId/craft params');
			if (!entityIdValidation.valid) {
				return res.status(400).json({ error: entityIdValidation.error });
			}

			if (typeof recipeId !== 'string' || recipeId.length === 0) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'recipeId is required.',
				});
			}

			if (typeof componentId !== 'string' || componentId.length === 0) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'componentId is required: all items must be attached to a component.',
				});
			}

			if (!Array.isArray(itemIds) || itemIds.length === 0) {
				return res.status(400).json({
					error: 'Bad Request',
					message: 'itemIds must be a non-empty array of item instance IDs.',
				});
			}

			// TYPED ID MIGRATION: Validate componentId and each itemId format
			const compValidation = validateCompId(componentId, 'POST /crafting/:entityId/craft body');
			if (!compValidation.valid) {
				return res.status(400).json({ error: compValidation.error });
			}
			for (const itemId of itemIds) {
				const itemValidation = validateItemId(itemId, 'POST /crafting/:entityId/craft body');
				if (!itemValidation.valid) {
					return res.status(400).json({ error: itemValidation.error });
				}
			}

			const result = worldStateController.craftItems(entityId, recipeId, componentId, itemIds);

			// Unknown recipe or entity → 404 (same semantics as inventory 404s).
			if (result.code === 'RECIPE_NOT_FOUND' || result.code === 'ENTITY_NOT_FOUND') {
				return res.status(404).json({
					error: 'Not Found',
					message: result.message,
				});
			}

			// Failed operation (component/item validation, multiset mismatch,
			// insufficient volume, unexpected mutation failure) → 400.
			if (!result.success) {
				return res.status(400).json({
					error: 'Failed to craft',
					message: result.message,
				});
			}

			res.json({
				success: true,
				recipeId: result.recipeId,
				consumed: result.consumed,
				produced: result.produced,
			});
		} catch (error) {
			Logger.error('/crafting/:entityId/craft endpoint error', { error: error.message });
			res.status(500).json({
				error: 'Internal Server Error',
				details: error.message,
			});
		}
	});
}
