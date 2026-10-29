/**
 * View API routes — GET /view/:id.
 *
 * The generic "what can I see?" payload for any live world entity (item,
 * object, component, or equipped slot), resolving through
 * WorldStateController.getViewData().
 *
 * Standard route shape (route patterns §5): the sole injected dependency is
 * the root world-state controller (facade-only-dependency rule) — the route
 * never reaches into a sub-controller. The payload is assembled by
 * WorldStateController.getViewData().
 *
 * Envelope:
 *   200 { view: <node> }
 *       node.kind in: 'entity' | 'component' | 'clothing' | 'item'
 *       (the clothing node replaces a component node per the clothing rule:
 *        a component holding worn clothing shows that clothing's data instead
 *        of its own data)
 *   400 { error: 'Invalid id type', details }     (id overlong, or no known
 *       typed prefix; a missing id never reaches this handler — the route
 *       does not match, so the app's 404 handling answers)
 *   404 { error: 'View not found', details }       (classified kind, no such id)
 *   500 { error: 'Internal Server Error', details? } (sendRouteError; details
 *       only when NODE_ENV !== 'production')
 *
 * The id's kind is derived from its typed prefix (IdPrefixes, BUG-107) and
 * classified ONCE at this boundary (T-1: narrow at the edge). The route then
 * calls the facade's getViewData(id, kind) — a controller that takes the id
 * plus the classified kind, and returns a node or null. No entity/comp/item/
 * "equipped" fanout: one payload per id, per the view contract.
 */
import Logger from '../utils/Logger.js';
import { sendRouteError } from '../utils/routeError.js';
import { ID_PREFIXES, isPrefixed } from '../../shared/IdPrefixes.js';

/**
 * Typed id prefix → the kind the view controller resolves. Classification is
 * a plain lookup (no regex, no substring test): the prefix is the id's type.
 * @type {Readonly<{ [key: string]: 'ENTITY' | 'COMPONENT' | 'ITEM' | 'EQUIPPED'> >}
 */
const KIND_BY_PREFIX = {
    [ID_PREFIXES.ENTITY]: 'ENTITY',
    [ID_PREFIXES.COMPONENT]: 'COMPONENT',
    [ID_PREFIXES.ITEM]: 'ITEM',
    [ID_PREFIXES.EQUIPPED]: 'EQUIPPED',
};

/**
 * Human label per kind, used in the 404 message.
 * @type {Readonly<{ [key: string]: string }>}
 */
const KIND_LABEL = {
    ENTITY: 'entity',
    COMPONENT: 'component',
    ITEM: 'item',
    EQUIPPED: 'equipped item',
};

/** Hard cap on the id path segment (SEC-2, size cap on inputs). */
const MAX_ID_LENGTH = 256;

/**
 * Classifies an id into a resolved kind, or null when it has no known typed
 * prefix.
 * @param {string} id - The id as typed.
 * @returns {'ENTITY'|'COMPONENT'|'ITEM'|'EQUIPPED'|null} The resolved kind or null.
 */
function resolveKind(id) {
    for (const prefix of Object.keys(KIND_BY_PREFIX)) {
        if (isPrefixed(id, prefix)) {
            return KIND_BY_PREFIX[prefix];
        }
    }
    return null;
}

/**
 * Registers the view routes on the shared router.
 * @param {import('express').Router} router - The shared routes router.
 * @param {Object} deps - Dependencies.
 * @param {Object} deps.worldStateController - The root world-state controller (facade).
 */
export function register(router, { worldStateController }) {
    router.get('/view/:id', (req, res) => {
        let id = req.params.id;
        if (typeof id !== 'string') {
            id = '';
        }
        // Belt-and-suspenders for the mount contract: the route itself
        // requires a segment, so an empty id is unreachable through this
        // handler; the guard documents the required-id rule and stays safe if
        // the mount ever widens (e.g. to a wildcard sub-router).
        if (id.length === 0) {
            return res.status(400).json({
                error: 'Invalid id type',
                details: 'id is required on /view/:id (typed id: ent-<uuid>, comp-<uuid>, item-<uuid>, eq-<uuid>).',
            });
        }
        if (id.length > MAX_ID_LENGTH) {
            return res.status(400).json({
                error: 'Invalid id type',
                details: `id too long (max ${MAX_ID_LENGTH} characters).`,
            });
        }

        const kind = resolveKind(id);
        if (!kind) {
            const prefixList = Object.keys(KIND_BY_PREFIX).join(', ');
            return res.status(400).json({
                error: 'Invalid id type',
                details: `No known id prefix on "${id}" (accepted prefixes: ${prefixList}).`,
            });
        }

        try {
            const view = worldStateController.getViewData(id, kind);
            if (!view) {
                const label = KIND_LABEL[kind] || kind.toLowerCase();
                return res.status(404).json({
                    error: 'View not found',
                    details: `No ${label} found with id "${id}".`,
                });
            }
            res.status(200).json({ view });
        } catch (error) {
            Logger.error(`[ViewRoutes] GET /view/${id} (${kind}) failed: ${error.message}`, { cause: error });
            sendRouteError(error, res, `GET /view/${id}`);
        }
    });
}
