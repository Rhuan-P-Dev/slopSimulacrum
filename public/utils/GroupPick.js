/**
 * GroupPick
 * Pure helpers for the Group Pick window (cluster pickup): cluster detection,
 * per-type stack grouping, quantity selection, and the data-driven config
 * resolution.
 *
 * Why this is a pure utility: the Group Pick window (GroupPickOverlayController)
 * is a thin DOM shell. Every decision the window displays or enforces — which
 * items form a cluster around a clicked item, how they stack by type, and
 * which concrete instances a quantity selects — is derived here so the rules
 * are unit-testable without a DOM and cannot drift inside the render path.
 *
 * The server remains the authority for the actual pickup: the window selects,
 * ActionExecutor fires one POST /pick-up-item per chosen instance (single
 * component, sequential), and the server re-checks range, volume, and
 * requirements for each item independently.
 *
 * @module GroupPick
 */

/**
 * Resolves the group-pick configuration from the pickUpItem action definition
 * delivered to the client. The capability projection (GET /actions) spreads
 * the raw action data, so the `pickUpItem.groupPick` sub-object from
 * data/actions.json arrives intact and is the data-driven source of truth.
 *
 * Falls back to the provided defaults when the field is absent or a value is
 * malformed — mirroring the range-fallback pattern the client already uses
 * for the pickup range circle (server value wins, sane default guards).
 *
 * @param {Object|null} pickUpAction - The pickUpItem entry of the client's availableActions.
 * @param {{ radius: number, minItems: number }} fallback - Fallback config (AppConfig.GROUP_PICK).
 * @returns {{ radius: number, minItems: number }}
 */
export function resolveGroupPickConfig(pickUpAction, fallback) {
    const gp = pickUpAction && typeof pickUpAction === 'object'
        ? pickUpAction.groupPick
        : undefined;
    const radius = gp && Number.isFinite(gp.radius) && gp.radius > 0
        ? gp.radius
        : fallback.radius;
    const minItems = gp && Number.isInteger(gp.minItems) && gp.minItems >= 1
        ? gp.minItems
        : fallback.minItems;
    return { radius, minItems };
}

/**
 * Selects the items forming a cluster around an anchor point: every item
 * whose Euclidean distance to (x, y) is <= radius (inclusive). Coordinates
 * are the room-relative dropped-item space — both the anchor and the
 * candidates come from the same room, so no space conversion is needed.
 *
 * @param {Array<Object>} items - Dropped items with numeric x, y.
 * @param {number} x - Anchor X.
 * @param {number} y - Anchor Y.
 * @param {number} radius - Inclusive cluster radius.
 * @returns {Array<Object>} The cluster items (original object identity).
 */
export function clusterAround(items, x, y, radius) {
    if (!Array.isArray(items) || !Number.isFinite(radius) || radius < 0) return [];
    const r2 = radius * radius;
    return items.filter((item) => {
        if (!item || !Number.isFinite(item.x) || !Number.isFinite(item.y)) return false;
        const dx = item.x - x;
        const dy = item.y - y;
        return dx * dx + dy * dy <= r2;
    });
}

/**
 * Groups items into stacks keyed by itemType, ordered by first appearance.
 * Each stack carries:
 *   - items: all instances (insertion order);
 *   - inRange / outOfRange: the split based on each item's pre-annotated
 *     `inRange` flag (App computes it with the same distance semantics the
 *     server enforces — the window never recomputes pickup range itself);
 *   - unitVolume / totalVolume: per-instance and summed volume, for the
 *     window's load preview.
 *
 * Out-of-range instances are displayed (dimmed) but never selectable — see
 * expandSelection.
 *
 * @param {Array<Object>} items
 * @returns {Array<{ itemType: string, name: string, items: Array<Object>, inRange: Array<Object>, outOfRange: Array<Object>, unitVolume: number, totalVolume: number }>}
 */
export function groupIntoStacks(items) {
    if (!Array.isArray(items)) return [];
    const stacks = new Map();
    for (const item of items) {
        if (!item || !item.itemType) continue;
        let stack = stacks.get(item.itemType);
        if (!stack) {
            stack = {
                itemType: item.itemType,
                name: item.name || item.itemType,
                items: [],
                inRange: [],
                outOfRange: [],
                unitVolume: Number.isFinite(item.volume) ? item.volume : 0,
                totalVolume: 0
            };
            stacks.set(item.itemType, stack);
        }
        stack.items.push(item);
        (item.inRange ? stack.inRange : stack.outOfRange).push(item);
        stack.totalVolume += (Number.isFinite(item.volume) ? item.volume : 0);
    }
    return [...stacks.values()];
}

/**
 * Matches a stack against the window's search filter: case-insensitive
 * substring match on the display name or the item type. An empty or
 * whitespace-only query matches everything.
 *
 * @param {Object} stack - Stack as produced by groupIntoStacks.
 * @param {string} query - Raw filter text.
 * @returns {boolean}
 */
export function matchesFilter(stack, query) {
    const q = (query || '').trim().toLowerCase();
    if (!q) return true;
    return stack.name.toLowerCase().includes(q) ||
        stack.itemType.toLowerCase().includes(q);
}

/**
 * Expands a stack's chosen quantity into the concrete instances to pick:
 * the FIRST `qty` in-range instances (stable insertion order). Out-of-range
 * instances are never part of a selection — the server would reject each of
 * them, so the UI cannot even offer them.
 *
 * @param {Object} stack - Stack as produced by groupIntoStacks.
 * @param {number} qty - Chosen quantity (clamped to 0..inRange.length).
 * @returns {Array<Object>}
 */
export function expandSelection(stack, qty) {
    if (!stack || !Array.isArray(stack.inRange)) return [];
    const max = stack.inRange.length;
    const n = Number.isInteger(qty) ? Math.min(Math.max(qty, 0), max) : 0;
    return stack.inRange.slice(0, n);
}

/**
 * Sums the volume of a selection, for the window's load preview.
 *
 * @param {Array<Object>} items
 * @returns {number}
 */
export function selectionVolume(items) {
    if (!Array.isArray(items)) return 0;
    return items.reduce((sum, item) => sum + (Number.isFinite(item.volume) ? item.volume : 0), 0);
}
