/**
 * RoundProseBuilder — turns a room's perception delta stream into round prose.
 *
 * Two different surfaces share "round prose" in this project:
 *
 *   1. The one-line ROUND summary (`buildRoundProse`) — counting phrasing
 *      ("3 observable changes across 2 rooms", live = "still planning").
 *      Kept as compact counting text: it is a meta-line, stable, and byte-pinned
 *      by contract tests. Untouched here.
 *
 *   2. The per-room NARRATIVE paragraph (`buildRoomProse`) — the dev-tab prose.
 *      This is the human-facing "what happened, in words" text. It is built
 *      from the delta entry's structured fields (not from the compact one-line
 *      `summary` the LLM reads), so the LLM perception wording is left exactly
 *      as-is while the prose reads like sentences.
 *
 *   Pure functions over plain objects: no world, no tick, no reader side
 *   effects. A prose-paragraph wording change touches only `buildRoomProse`.
 *   All output is deterministic (no timestamps, no ids) so identically driven
 *   worlds produce byte-identical prose.
 *
 * @module RoundProseBuilder
 */

import { recoverChunkMaterial } from './Constants.js';
import { componentTypeName } from './ComponentNaming.js';

/**
 * Uppercase the first non-whitespace character, leaving the rest untouched.
 * @param {string} s
 * @returns {string}
 */
function capitalizeFirst(s) {
    return (s || '').replace(/\S/, (c) => c.toUpperCase());
}

/**
 * "a, b, and c" / "a and b" / "a".
 * @param {string[]} parts
 * @returns {string}
 */
function joinChunk(parts) {
    if (!parts?.length) return '';
    if (parts.length === 1) return parts[0];
    if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
    return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

/**
 * Join an ordered list of lower-case clause fragments into one or more
 * sentence-fragments. Chunks of up to three clauses per sentence; the first
 * word of the *first* sentence is un-capitalized when `firstWordLower` is set
 * (the sentence then opens with a location prefix like "In the room, ...").
 * Returns WITHOUT a trailing period; the caller adds one.
 * @param {string[]} clauses
 * @param {{ firstWordLower?: boolean }} opts
 * @returns {string}
 */
function assemble(clauses, { firstWordLower = false } = {}) {
    if (!clauses?.length) return '';
    const chunks = [];
    for (let i = 0; i < clauses.length; i += 3) chunks.push(clauses.slice(i, i + 3));
    const parts = chunks
        .map((chunk) => joinChunk(chunk))
        .filter(Boolean);
    if (parts.length === 0) return '';
    // Subsequent sentences always begin with a capital letter. The first
    // sentence's case is left as the clause author wrote it: a lower-case common
    // word ("a knife") stays lower after an "In the room, " prefix, while a proper
    // name ("Test Droid") keeps its capital. Only when the sentence itself starts
    // with the clause (no location prefix) do we capitalise it.
    for (let idx = 0; idx < parts.length; idx += 1) {
        if (idx > 0 || !firstWordLower) parts[idx] = capitalizeFirst(parts[idx]);
    }
    return parts.join('. ');
}

/**
 * A hex-ish machine/entity id: "ent-3382b7f0-…" . True for raw ids, false for
 * human names.
 * @param {string} s
 * @returns {boolean}
 */
function isIdLike(s) {
    return /^[a-z][a-z0-9]*-[0-9a-f-]{8,}$/i.test(s || '');
}

/**
 * Prefer a human `name`; when the name is a raw id (or empty) return the
 * supplied generic fallback instead.
 * @param {*} name
 * @param {string} generic
 * @returns {string}
 */
function displayOrGeneric(name, generic) {
    const n = name && typeof name === 'string' ? name.trim() : '';
    if (n && !isIdLike(n)) return n;
    return generic || n;
}

/**
 * A definite article from the item's first letter: "a knife" / "an iron chip".
 * @param {string} name
 * @returns {string}
 */
function article(name) {
    const n = (name || '').trim();
    if (!n) return '';
    return /[aeiou]/i.test(n[0]) ? 'an' : 'a';
}

/**
 * The display name for a held / floor item row. Prefers the display name the
 * perception controller resolved from the registry; for chunk types it derives
 * "<Material> chunk" the way the world itself names them; otherwise title-cases
 * the raw key.
 * @param {Object|null} row
 * @returns {string}
 */
function prettyItemName(row) {
    const name = row && typeof row === 'object' ? row.name : undefined;
    if (typeof name === 'string' && name.trim() !== '') return name;
    const type = row && typeof row === 'object' ? row.type ?? row.itemType : undefined;
    if (typeof type === 'string' && type !== '') {
        const mat = recoverChunkMaterial(type);
        if (mat) return `${capitalizeFirst(mat)} chunk`;
        return type
            .replace(/_/g, ' ')
            .split(' ')
            .filter(Boolean)
            .map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
            .join(' ');
    }
    return '';
}

/**
 * A list of item display names, each with a definite article, joined naturally.
 * @param {string[]} names
 * @returns {string}
 */
function listWithArticles(names) {
    return joinChunk(names.map((n) => `${article(n)} ${n}`));
}

/**
 * Join names into a natural noun phrase: "A and B" / "A, B, and C".
 * @param {string[]} names
 * @returns {string}
 */
function listNames(names) {
    return joinChunk(names);
}

/**
 * A short, natural verb phrase for a performed action, keyed on the action
 * registry name. Unknown actions fall back to "did <action>".
 * @param {string|null} action
 * @returns {string}
 */
function actionVerb(action) {
    switch (String(action ?? '')) {
        case 'move':
            return 'moved';
        case 'dash':
            return 'dashed';
        case 'selfHeal':
            return 'healed itself';
        case 'droid punch':
            return 'threw a punch';
        case 'cut':
            return 'cut something';
        case 'dropItem':
            return 'dropped an item';
        case 'placeMachine':
            return 'placed a machine';
        case 'retrieveMachine':
            return 'retrieved a machine';
        case 'pickUpItem':
            return 'picked up an item';
        case 'shootT1':
            return 'fired the T1';
        case 'hand shotgun':
            return 'fired the shotgun';
        default:
            return `did ${action}`;
    }
}

/**
 * One ordered lower-case clause fragment per observable event, in a reading
 * order that reads like a short narrative: the main actions first, then the
 * consequences (drops, picked-up items), then the quieter state shifts.
 * @param {Object} entry
 * @returns {string[]}
 */
function entryClauses(entry) {
    const out = [];
    const push = (c) => {
        if (c && c.trim()) out.push(c.trim());
    };
    const entities = entry.entities || {};
    const items = entry.items || {};
    const dropped = entry.dropped || {};
    const comps = entry.components || {};
    const equipped = entry.equipped || {};
    const internal = entry.internal || {};

    // Main events: what the room's entities did.
    (entry.actions?.performed || []).forEach((a) => {
        const actor = displayOrGeneric(a?.name, 'an entity');
        push(`${actor} ${actionVerb(a?.action)}`);
    });
    // Floor items the punch / damage knocked loose.
    (dropped.added || []).forEach((row) => {
        const item = prettyItemName(row);
        if (!item) return;
        const actor = row.actor?.name ? displayOrGeneric(row.actor.name, 'someone') : null;
        if (actor) push(`${actor} dropped ${article(item)} ${item}`);
        else push(`${article(item)} ${item} came to rest on the floor`);
    });
    // Items that came to rest, or were picked up / nudged.
    (dropped.removed || []).forEach((row) => {
        const item = prettyItemName(row);
        if (!item) return;
        const actor = row.actor?.name ? displayOrGeneric(row.actor.name, 'someone') : null;
        if (actor) push(`${actor} picked up ${article(item)} ${item}`);
        else push(`${article(item)} ${item} was picked up`);
    });
    if (dropped.moved?.length) {
        const items = (dropped.moved || []).map((r) => prettyItemName(r)).filter(Boolean);
        if (items.length) push(`${listWithArticles(items)} shifted on the floor`);
    }
    // Held items that appeared / vanished (e.g. crafted in hand).
    if (items.added?.length) {
        const names = (items.added || []).map((r) => prettyItemName(r)).filter(Boolean);
        if (names.length) push(`${listWithArticles(names)} appeared`);
    }
    if (items.removed?.length) {
        const names = (items.removed || []).map((r) => prettyItemName(r)).filter(Boolean);
        if (names.length) push(`${listWithArticles(names)} disappeared`);
    }
    // Equipped / unequipped.
    (equipped.added || []).forEach((row) => {
        const item = prettyItemName(row);
        if (!item) return;
        const actor = row.actor?.name ? displayOrGeneric(row.actor.name, 'someone') : null;
        if (actor) push(`${actor} equipped ${article(item)} ${item}`);
        else push(`${article(item)} ${item} was equipped`);
    });
    (equipped.removed || []).forEach((row) => {
        const item = prettyItemName(row);
        if (!item) return;
        const actor = row.actor?.name ? displayOrGeneric(row.actor.name, 'someone') : null;
        if (actor) push(`${actor} unequipped ${article(item)} ${item}`);
        else push(`${article(item)} ${item} was unequipped`);
    });
    // Presence changes: who arrived, left, or moved.
    if (entities.appeared?.length) {
        const names = (entities.appeared || []).map((e) => displayOrGeneric(e.name, 'an entity')).filter(Boolean);
        if (names.length) push(`${listNames(names)} appeared in the room`);
    }
    if (entities.despawned?.length) {
        const names = (entities.despawned || []).map((e) => displayOrGeneric(e.name, 'an entity')).filter(Boolean);
        if (names.length) push(`${listNames(names)} left the room`);
    }
    if (entities.moved?.length) {
        const names = (entities.moved || []).map((e) => displayOrGeneric(e.name, 'an entity')).filter(Boolean);
        if (names.length) push(`${listNames(names)} moved`);
    }
    // The quieter state shifts (stats, component damage).
    if (entities.statChanges?.length) {
        (entities.statChanges || []).forEach((s) => {
            const who = displayOrGeneric(s.name, 'an entity');
            push(`${who} had a stat change in ${s.statName || 'one of its stats'}`);
        });
    }
    if (comps.changed?.length) {
        (comps.changed || []).forEach((row) => {
            const part = componentTypeName(row.type ?? row.componentId);
            if (!part) {
                push('a part had a stat change');
                return;
            }
            push(`${article(part)} ${part} had a stat change`);
        });
    }
    // Internal parts (rare) — one gentle line.
    if (internal.added?.length || internal.removed?.length) {
        push('internal parts changed');
    }
    return out;
}

/**
 * The first-observation paragraph (a room seen for the first time). Opens with
 * "Initial observation of <room>:" — the phrasing the round-prose contract
 * pins — and describes what is already there.
 * @param {Object} entry
 * @param {string} roomName
 * @returns {string}
 */
function baselineText(entry, roomName) {
    const rn = roomName || 'the room';
    const entities = (entry.entities || {}).appeared || [];
    const dropped = (entry.dropped || {}).added || [];
    let text;
    const names = entities.map((e) => displayOrGeneric(e.name, 'an entity')).filter(Boolean);
    if (names.length) {
        const verb = names.length === 1 ? 'is' : 'are';
        text = `Initial observation of ${rn}: ${listNames(names)} ${verb} in the room`;
    } else {
        text = `Initial observation of ${rn}: nothing notable in the room`;
    }
    if (dropped.length) {
        const items = dropped.map((r) => prettyItemName(r)).filter(Boolean);
        if (items.length) text += `; ${listWithArticles(items)} rest on the floor`;
    }
    return `${text}.`;
}

/**
 * One room, as one paragraph: its delta entries (oldest → newest) turned into
 * flowing narrative sentences. The room name is mentioned once, at the front of
 * the first sentence; later sentences continue without repeating it.
 * @param {{ entries: Array|null, roomName: string|null }} ctx
 * @returns {string} — '' when the room had nothing worth saying
 */
export function buildRoomProse({ entries = null, roomName = null } = {}) {
    const rn = roomName || 'the room';
    const sentences = [];
    let roomNamed = false;
    for (const entry of entries ?? []) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.kind === 'baseline') {
            sentences.push(baselineText(entry, rn));
            roomNamed = true;
            continue;
        }
        const clauses = entryClauses(entry);
        if (!clauses.length) continue;
        const body = assemble(clauses, { firstWordLower: !roomNamed });
        if (!body) continue;
        if (roomNamed) {
            sentences.push(`${capitalizeFirst(body)}.`);
        } else {
            sentences.push(`In ${rn}, ${body}.`);
        }
        roomNamed = true;
    }
    return sentences.length ? sentences.join(' ') : '';
}

/**
 * One round, as summary + per-room paragraphs. Counting phrasing is English:
 * "X observable change(s) across Y room(s)", where entryCount is the total
 * entries across rooms and Y counts rooms that have at least one. Live rounds
 * say "still planning" ("... so far" when entries exist, "(no change yet)" when
 * not); closed rounds say "recorded ..." or "passed with no observable changes".
 * @param {{ round: number, live: boolean, startTick: number, endTick: number, rooms: Object<string, { name: string, text: string, entryCount: number }>|null }} ctx
 * @returns {{ summary: string, entryCount: number, rooms: Object }}
 */
export function buildRoundProse({ round, live = false, startTick = 0, endTick = 0, rooms = null }) {
    const roomsObj = rooms ?? {};
    const entryCount = Object.values(roomsObj).reduce((sum, room) => sum + (room?.entryCount ?? 0), 0);
    const roomCount = Object.keys(roomsObj).length;
    const tickSpan = `ticks ${startTick} to ${endTick}`;
    let summary;
    if (entryCount === 0) {
        summary = live
            ? `Round ${round} (${tickSpan}) is still planning (no change yet).`
            : `Round ${round} (${tickSpan}) passed with no observable changes.`;
    } else {
        const changePhrase = `${entryCount} observable change${entryCount === 1 ? '' : 's'} across ${roomCount} room${roomCount === 1 ? '' : 's'}`;
        summary = live
            ? `Round ${round} (${tickSpan}) is still planning; ${changePhrase} so far.`
            : `Round ${round} (${tickSpan}) recorded ${changePhrase}.`;
    }
    return { summary, entryCount, rooms: roomsObj };
}
