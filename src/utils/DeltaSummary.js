/**
 * DeltaSummary — turns a perception delta entry into a single human/LLM-readable sentence.
 *
 * **Why a separate module:** the perception surface has two jobs with different
 * change drivers — *classifying* what changed (DeltaDiff) and *naming* it in a
 * sentence (this module). When the agent's context budget grows, the *phrasing*
 * of the sentence may need adjusting without touching the diff logic, and vice
 * versa. Both are pure functions of the delta entry.
 *
 * The sentence is deliberately short: the perception section of the LLM context
 * is one of the few sections that must always fit (it is the "freshest" info an
 * agent can trust, and the context budget is a hard cap). A summary is therefore
 * *counts + representative examples*, never a full listing — full detail lives
 * in the delta entry itself, which the client/UI can consume structurally.
 *
 * @module DeltaSummary
 */

/**
 * Groups a list of entries by a field and returns `{ type: count }` pairs
 * ordered by descending count. Used to compress "2 knife, 3 tool" into
 * "3x tool, 2x knife".
 *
 * @param {Array} entries
 * @param {string} field - name of the field to group by
 * @returns {{ [type]: number }[]}
 */
export function groupBy(entries, field) {
    const byType = {};
    for (const entry of entries ?? []) {
        const key = entry?.[field];
        if (key == null) continue;
        byType[key] = (byType[key] ?? 0) + 1;
    }
    return Object.entries(byType)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .map(([type, count]) => ({ type, count }));
}

/**
 * "3x tool, 2x knife" — compresses a type list into counts.
 * @param {Array<{ type: string }>} entries
 * @returns {string}
 */
export function typeCountPhrase(entries) {
    return groupBy(entries, 'type')
        .slice(0, 3)
        .map(({ type, count }) => (count > 1 ? `${type} x${count}` : type))
        .join(', ');
}

/**
 * "Wood chunk x2, Knife" — compresses an item list into display-name counts.
 * Groups by the item's human *name* (falling back to the type key when the
 * delta row carries no name yet), ordered by descending count, capped at the
 * 3 most common types so the sentence stays compact. Rows may come from the
 * item, dropped, or equipped diff lists; the name is added by the controller.
 *
 * @param {Array<{ name?: string, type?: string, itemType?: string }>} entries
 * @returns {string}
 */
export function itemPhrase(entries) {
    const byName = {};
    for (const e of entries ?? []) {
        const name = (e && (e.name ?? e.type ?? e.itemType));
        if (name == null) continue;
        byName[name] = (byName[name] ?? 0) + 1;
    }
    return Object.entries(byName)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        .slice(0, 3)
        .map(([name, count]) => (count > 1 ? `${name} x${count}` : name))
        .join(', ');
}

/**
 * Builds the one-line summary for a delta entry.
 * Returns `''` when nothing changed (caller treats it as "no changes").
 * For baselines it describes the room's contents ("initial observation"), not
 * a change — an agent must learn *what is there* before it can learn *what
 * changed*.
 *
 * @param {Object} delta - delta entry from DeltaDiff (summary: null)
 * @param {string} [roomName] - optional human-readable room name (fallback to roomId)
 * @returns {string}
 */
export function buildDeltaSummary(delta, roomName = null) {
    if (!delta || typeof delta !== 'object') return '';
    const parts = [];
    if (delta.kind === 'baseline') {
        const entityNamePhrase = (delta.entities?.appeared ?? [])
            .slice(0, 3)
            .map((e) => e.name)
            .join(', ');
        const droppedNamePhrase = itemPhrase((delta.dropped?.added ?? []).slice(0, 3));
        parts.push(`initial observation of ${roomName ?? delta.roomId}: ${delta.entities.appeared.length} entit${delta.entities.appeared.length === 1 ? '' : 'ies'} ${entityNamePhrase ? `(${entityNamePhrase})` : ''}, ${delta.counts.dropped ?? 0} dropped item(s)${droppedNamePhrase ? ` (${droppedNamePhrase})` : ''}`);
    } else {
        const roomRef = `in ${roomName ?? delta.roomId}`;
        const entityCounts = [
            delta.entities?.appeared?.length ? `${delta.entities.appeared.length} entit${delta.entities.appeared.length === 1 ? 'y' : 'ies'} appeared` : null,
            delta.entities?.despawned?.length ? `${delta.entities.despawned.length} entit${delta.entities.despawned.length === 1 ? 'y' : 'ies'} despawned` : null,
            delta.entities?.moved?.length ? `${delta.entities.moved.length} entit${delta.entities.moved.length === 1 ? 'y' : 'ies'} moved` : null,
            delta.entities?.statChanges?.length ? `${delta.entities.statChanges.length} stat change${delta.entities.statChanges.length === 1 ? '' : 's'}` : null
        ].filter(Boolean);
        if (entityCounts.length) parts.push(`${entityCounts.length === 1 ? entityCounts[0] : entityCounts.join('; ')} ${roomRef}`);
        // Actions the room's entities performed since the last observation
        // (filled by the PerceptionController from the attribution store).
        // Representative examples only — the full rows live on the entry.
        const performed = delta.actions?.performed ?? [];
        if (performed.length) {
            const examples = performed
                .slice(0, 3)
                .map((a) => `${a.action} by ${a.name ?? a.entity}`)
                .join(', ');
            const more = performed.length > 3 ? `, +${performed.length - 3} more` : '';
            parts.push(`${performed.length} action${performed.length === 1 ? '' : 's'} performed (${examples}${more}) ${roomRef}`);
        }
        const itemAdded = delta.items?.added?.length;
        const itemRemoved = delta.items?.removed?.length;
        if (itemAdded) {
            const phrase = itemPhrase(delta.items.added.slice(0, 5)) || 'items';
            parts.push(`${itemAdded} item${itemAdded === 1 ? '' : 's'} added (${phrase}) ${roomRef}`);
        }
        if (itemRemoved) {
            const phrase = itemPhrase(delta.items.removed.slice(0, 5)) || 'items';
            parts.push(`${itemRemoved} item${itemRemoved === 1 ? '' : 's'} removed (${phrase}) ${roomRef}`);
        }
        const dropped = [
            delta.dropped?.added?.length ? `${delta.dropped.added.length} dropped item${delta.dropped.added.length === 1 ? '' : 's'} appeared (${itemPhrase(delta.dropped.added.slice(0, 5)) || 'items'})` : null,
            delta.dropped?.removed?.length ? `${delta.dropped.removed.length} dropped item${delta.dropped.removed.length === 1 ? '' : 's'} picked up (${itemPhrase(delta.dropped.removed.slice(0, 5)) || 'items'})` : null,
            delta.dropped?.moved?.length ? `${delta.dropped.moved.length} dropped item${delta.dropped.moved.length === 1 ? '' : 's'} moved (${itemPhrase(delta.dropped.moved.slice(0, 5)) || 'items'})` : null
        ].filter(Boolean);
        if (dropped.length) parts.push(dropped.join('; ') + ` ${roomRef}`);
        const comp = [
            delta.components?.changed?.length ? `${delta.components.changed.length} component stat change${delta.components.changed.length === 1 ? '' : 's'}` : null,
            delta.components?.removed?.length ? `${delta.components.removed.length} component${delta.components.removed.length === 1 ? '' : 's'} broken` : null
        ].filter(Boolean);
        if (comp.length) parts.push(comp.join('; ') + ` ${roomRef}`);
        // New lines in the room's chat transcript since the last observation
        // ("things said in chat"). Counts + representative examples only — the
        // full lines live in `entry.chat.added` / the room chat ring.
        const chatCount = (delta.chat?.added ?? []).length;
        if (chatCount) {
            const examples = (delta.chat?.added ?? [])
                .slice(0, 3)
                .map((m) => {
                    const raw = m?.text ?? '';
                    const short = (raw.replace(/"/g, '')).slice(0, 24);
                    return `${m?.speakerName ?? 'Someone'}: "${short}${raw.length > 24 ? '…' : ''}"`;
                })
                .join(', ');
            parts.push(`${chatCount} message${chatCount === 1 ? '' : 's'} in chat (${examples}) ${roomRef}`);
        }
        const intAdded = delta.internal?.added?.length;
        const intRemoved = delta.internal?.removed?.length;
        if (intAdded) parts.push(`${intAdded} internal component installed ${roomRef}`);
        if (intRemoved) parts.push(`${intRemoved} internal component removed ${roomRef}`);
        const eqAdded = delta.equipped?.added?.length;
        const eqRemoved = delta.equipped?.removed?.length;
        if (eqAdded) {
            const phrase = itemPhrase(delta.equipped.added.slice(0, 5)) || 'items';
            parts.push(`${eqAdded} equipped item${eqAdded === 1 ? '' : 's'} equipped (${phrase}) ${roomRef}`);
        }
        if (eqRemoved) {
            const phrase = itemPhrase(delta.equipped.removed.slice(0, 5)) || 'items';
            parts.push(`${eqRemoved} equipped item${eqRemoved === 1 ? '' : 's'} unequipped (${phrase}) ${roomRef}`);
        }
    }
    const summary = parts.join('. ');
    return summary.trim();
}
