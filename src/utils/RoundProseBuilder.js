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
import { formatPosition } from '../../shared/CoordFormat.js';

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
 * supplied generic fallback instead. A raw id is never echoed, so when both
 * the name and the generic are empty the result is empty (the caller drops
 * the phrase rather than falling back to the id).
 * @param {*} name
 * @param {string|null} generic
 * @returns {string}
 */
function displayOrGeneric(name, generic) {
    const n = name && typeof name === 'string' ? name.trim() : '';
    if (n && !isIdLike(n)) return n;
    return generic || '';
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

/** A finite number, or null when the value is missing / non-numeric. */
function finiteNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * Renders a stat value as deterministic text: finite numbers normalized to at
 * most 8 decimals (binary float noise stripped, trailing zeros trimmed),
 * strings passed through, `null`/`undefined`/`NaN` -> null.
 * @param {*} value
 * @returns {string|null}
 */
function statValue(v) {
    if (v == null) return null;
    const n = Number(v);
    if (Number.isFinite(n)) {
        return stripTrailingZeros(n.toFixed(8));
    }
    return String(v);
}

/** "80.00300000" -> "80.003"; "100.00000000" -> "100". */
function stripTrailingZeros(s) {
    const i = s.indexOf('.');
    if (i === -1) return s;
    const t = s.replace(/0+$/, '');
    return t.endsWith('.') ? t.slice(0, -1) : t;
}

/**
 * " (from 15 to 13)" — omits null sides ("(to 13)" / "(from 15)"); empty
 * string when both sides are null.
 * @param {*} from
 * @param {*} to
 * @returns {string}
 */
function valuePhrase(from, to) {
    const f = statValue(from);
    const t = statValue(to);
    if (f == null && t == null) {
        return '';
    }
    let inner;
    if (f != null && t != null) {
        inner = `from ${f} to ${t}`;
    } else if (f != null) {
        inner = `from ${f}`;
    } else {
        inner = `to ${t}`;
    }
    return ` (${inner})`;
}

/**
 * Display name for an action's target (from the attribution store's resolved
 * `{ id, name, componentId, componentName }`), or null when nothing usable.
 * @param {Object|null} target
 * @returns {string|null}
 */
function targetPhrase(target) {
    if (!target || typeof target !== 'object') return null;
    let phrase = target.name ? displayOrGeneric(target.name, '') : null;
    if (!phrase && target.componentName) {
        phrase = componentTypeName(target.componentName) ?? target.componentName;
    }
    return phrase ? phrase : null;
}

/** Display names from `{ type, id }` part rows, in input order. */
function partList(rows) {
    const names = [];
    (rows || []).forEach((row) => {
        if (!row || typeof row !== 'object') return;
        const t = componentTypeName(row.type ?? row.id);
        if (t) names.push(t);
    });
    return names;
}

/**
 * A lower-case light clause for the room suffix: "dim light" / "bright light"
 * / "flickering light" / "darkness". Null (so the caller drops the clause)
 * when the level is missing or empty. "dark" maps to "darkness" (a bare
 * adjective would not fit the "<level> light" noun-phrase pattern); all other
 * levels become "<level> light".
 * @param {*} level
 * @returns {string|null}
 */
function lightLevelPhrase(level) {
    const lv = level && typeof level === 'string' ? level.trim() : '';
    if (!lv) return null;
    return lv === 'dark' ? 'darkness' : `${lv} light`;
}

/**
 * Room display name plus the context suffix used by the first sentence:
 * " (20 x 12, map position (4.00, 7.00), a temperature of 18.5, dim light,
 * and a stone hall with a north door)". Each part is a lower-case property
 * clause joined by joinChunk. Atmosphere is an optional static block (validated
 * in RoomsController) rendered after the description, each present field
 * becoming one clause. Empty string when no room object (or none of
 * name/width/height/x/y/description/atmosphere) is supplied. Deterministic; raw
 * id-valued fields are simply skipped.
 * @param {string|null} roomName
 * @param {Object|null} room
 * @returns {{ rn: string, suffix: string }}
 */
function roomContext(roomName, room) {
    const r = room && typeof room === 'object' ? room : {};
    const rn =
        (roomName && String(roomName).trim() !== '')
            ? String(roomName)
            : (r.name && typeof r.name === 'string' ? String(r.name) : 'the room');
    const parts = [];
    const w = finiteNum(r.width);
    const h = finiteNum(r.height);
    if (w != null && h != null) parts.push(`${w} x ${h}`);
    const rx = finiteNum(r.x);
    const ry = finiteNum(r.y);
    if (rx != null && ry != null) parts.push(`map position ${formatPosition(rx, ry)}`);
    const desc = typeof r.description === 'string' ? r.description.trim() : '';
    if (desc) parts.push(desc);
    // Atmosphere (optional static room block): each present field becomes one
    // lower-case property clause, appended after the description.
    const a = r.atmosphere && typeof r.atmosphere === 'object' ? r.atmosphere : {};
    const t = finiteNum(a.temperature);
    if (t != null) parts.push(`a temperature of ${statValue(t)}`);
    const level = lightLevelPhrase(a.lightLevel);
    if (level) parts.push(level);
    const smell = typeof a.smell === 'string' ? a.smell.trim() : '';
    if (smell) parts.push(`the smell of ${smell}`);
    const sound = typeof a.ambientSound === 'string' ? a.ambientSound.trim() : '';
    if (sound) parts.push(`the sound of ${sound}`);
    return { rn, suffix: parts.length ? ` (${joinChunk(parts)})` : '' };
}

/**
 * A machine clause. `mode 'event'` (a placement/retrieval happened this window):
 * "Maria placed Furnace 1 at (10.00, 5.00)". `mode 'baseline'` (a machine
 * standing in the room at first observation — a state fact, not an event):
 * "Furnace 1 stands in the room at (10.00, 5.00) (placed by Maria)".
 * @param {Object|null} row — machines.placed/retrieved row
 * @param {'event'|'baseline'} mode
 * @returns {string|null}
 */
function machineClause(row, mode) {
    if (!row || typeof row !== 'object') return null;
    const typePhrase =
        componentTypeName(row.type) || (row.type ? String(row.type) : null);
    if (!typePhrase) return null;
    const pos =
        finiteNum(row.x) != null || finiteNum(row.y) != null
            ? ` at ${formatPosition(row.x, row.y)}`
            : '';
    const name = row.name && !isIdLike(row.name) ? String(row.name) : null;
    const placedBy = row.placedBy ? displayOrGeneric(row.placedBy, null) : null;
    if (mode === 'baseline') {
        const by = placedBy ? ` (placed by ${placedBy})` : '';
        if (name) return `${name} stands in the room${by}${pos}`;
        return `${article(typePhrase)} ${typePhrase} stands in the room${by}${pos}`;
    }
    if (name && placedBy) {
        return `${placedBy} placed ${name}${pos}`;
    }
    if (placedBy) {
        return `${placedBy} placed ${article(typePhrase)} ${typePhrase}${pos}`;
    }
    return `${article(typePhrase)} ${typePhrase} was placed in the room${pos}`;
}

/**
 * One ordered lower-case clause fragment per observable event, in a reading
 * order that reads like a short narrative: the main actions first, then the
 * consequences (drops, picked-up items, held items, machines), then presence,
 * then the quieter state shifts, then what was said. Raw ids never surface; the
 * perception display rule (shared/CoordFormat.js) formats every coordinate.
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
    const machines = entry.machines || {};

    // Main events: what the room's entities did (including against whom and
    // which components powered the action).
    (entry.actions?.performed || []).forEach((a) => {
        const actor = displayOrGeneric(a?.name, 'an entity');
        let clause = `${actor} ${a?.action ? actionVerb(a.action) : 'acted'}`;
        const target = targetPhrase(a?.target);
        if (target) clause += ` against ${target}`;
        const parts = partList(a?.used);
        if (parts.length) clause += `, powered by ${listNames(parts)}`;
        push(clause);
    });
    // Floor items the punch / damage knocked loose, or that appeared on the
    // floor. `x`, `y` are display coordinates when present.
    (dropped.added || []).forEach((row) => {
        const item = prettyItemName(row);
        if (!item) return;
        const pos =
            finiteNum(row?.x) != null || finiteNum(row?.y) != null
                ? ` at ${formatPosition(row.x, row.y)}`
                : '';
        const owner = displayOrGeneric(row.actor?.name ?? row.ownerId, 'someone');
        if (owner) {
            push(`${owner} dropped ${article(item)} ${item} on the floor${pos}`);
        } else {
            push(`${article(item)} ${item} came to rest on the floor${pos}`);
        }
    });
    // Objects that left the floor (picked up).
    (dropped.removed || []).forEach((row) => {
        const item = prettyItemName(row);
        if (!item) return;
        const owner = displayOrGeneric(row.actor?.name ?? row.ownerId, 'someone');
        if (owner) {
            push(`${owner} picked up ${article(item)} ${item}`);
        } else {
            push(`${article(item)} ${item} was picked up`);
        }
    });
    // Objects that moved on the floor.
    if (dropped.moved?.length) {
        const rows = (dropped.moved || []).filter((r) => r && typeof r === 'object');
        if (rows.length === 1) {
            const r = rows[0];
            const item = prettyItemName(r);
            if (item) {
                const fx = r.fromXY ? formatPosition(r.fromXY.x, r.fromXY.y) : null;
                const tx = r.toXY ? formatPosition(r.toXY.x, r.toXY.y) : null;
                if (fx && tx) {
                    push(`${article(item)} ${item} shifted on the floor from ${fx} to ${tx}`);
                } else {
                    push(`${article(item)} ${item} shifted on the floor`);
                }
            }
        } else if (rows.length) {
            const movedItems = rows.map((r) => prettyItemName(r)).filter(Boolean);
            if (movedItems.length) {
                push(`${listWithArticles(movedItems)} shifted on the floor`);
            }
        }
    }
    // Held items that appeared / vanished (e.g. crafted in hand).
    if (items.added?.length) {
        (items.added || []).forEach((row) => {
            const item = prettyItemName(row);
            if (!item) return;
            const holder = displayOrGeneric(row?.entity, null);
            const clause = holder
                ? `${article(item)} ${item} appeared in ${holder}'s hand`
                : `${article(item)} ${item} appeared`;
            push(clause);
        });
    }
    if (items.removed?.length) {
        (items.removed || []).forEach((row) => {
            const item = prettyItemName(row);
            if (!item) return;
            const holder = displayOrGeneric(row?.entity, null);
            const clause = holder
                ? `${article(item)} ${item} disappeared from ${holder}'s hand`
                : `${article(item)} ${item} disappeared`;
            push(clause);
        });
    }
    // Equipped / unequipped.
    (equipped.added || []).forEach((row) => {
        const item = prettyItemName(row);
        if (!item) return;
        const holder = displayOrGeneric(row?.entity, 'someone');
        push(`${holder} equipped ${article(item)} ${item}`);
    });
    (equipped.removed || []).forEach((row) => {
        const item = prettyItemName(row);
        if (!item) return;
        const holder = displayOrGeneric(row?.entity, 'someone');
        push(`${holder} unequipped ${article(item)} ${item}`);
    });

    // Machines placed / retrieved in the room (who placed what where; the
    // machine-tagged entity rows are deliberately NOT also narrated below,
    // so a placement is not said twice).
    (machines.placed || []).forEach((row) => {
        const clause = machineClause(row, 'event');
        if (clause) push(clause);
    });
    (machines.retrieved || []).forEach((row) => {
        if (!row || typeof row !== 'object') return;
        const typePhrase =
            componentTypeName(row.type) || (row.type ? String(row.type) : null);
        if (!typePhrase) return;
        const pos =
            finiteNum(row.x) != null || finiteNum(row.y) != null
                ? ` at ${formatPosition(row.x, row.y)}`
                : '';
        const name = row.name && !isIdLike(row.name) ? String(row.name) : null;
        const placedBy = row.placedBy ? displayOrGeneric(row.placedBy, null) : null;
        let clause = name
            ? `${name} was retrieved${pos}`
            : `${article(typePhrase)} ${typePhrase} was retrieved${pos}`;
        if (placedBy) clause += ` (it had been placed by ${placedBy})`;
        push(clause);
    });

    // Presence changes: who arrived, left, or moved (machine-tagged rows are
    // handled by the machine clauses above).
    if (entities.appeared?.length) {
        (entities.appeared || []).forEach((e) => {
            if (!e || typeof e !== 'object') return;
            if (e.machine) return;
            const name = displayOrGeneric(e.name, 'an entity');
            const pos =
                finiteNum(e.x) != null || finiteNum(e.y) != null
                    ? ` at ${formatPosition(e.x, e.y)}`
                    : '';
            push(`${name} appeared in the room${pos}`);
        });
    }
    if (entities.despawned?.length) {
        (entities.despawned || []).forEach((e) => {
            if (!e || typeof e !== 'object') return;
            if (e.machine) return;
            const name = displayOrGeneric(e.name, 'an entity');
            const pos =
                finiteNum(e.x) != null || finiteNum(e.y) != null
                    ? ` from ${formatPosition(e.x, e.y)}`
                    : '';
            push(`${name} left the room${pos}`);
        });
    }
    if (entities.moved?.length) {
        (entities.moved || []).forEach((e) => {
            if (!e || typeof e !== 'object') return;
            const name = displayOrGeneric(e.name, 'an entity');
            let verb;
            switch (String(e.action ?? '')) {
                case 'dash':
                    verb = 'dashed';
                    break;
                case 'walk':
                    verb = 'walked';
                    break;
                default:
                    verb = 'moved';
            }
            let clause = `${name} ${verb}`;
            const fr = e.fromRoom ? displayOrGeneric(e.fromRoom, null) : null;
            const tr = e.toRoom ? displayOrGeneric(e.toRoom, null) : null;
            if (fr && tr) {
                clause += ` from ${fr} to ${tr}`;
            } else if (tr) {
                clause += ` into ${tr}`;
            } else if (fr) {
                clause += ` out of ${fr}`;
            }
            if (e.fromXY || e.toXY) {
                const fx = e.fromXY ? formatPosition(e.fromXY.x, e.fromXY.y) : null;
                const tx = e.toXY ? formatPosition(e.toXY.x, e.toXY.y) : null;
                if (fx && tx) {
                    clause += (fr || tr) ? ` (from ${fx} to ${tx})` : ` from ${fx} to ${tx}`;
                }
            }
            const parts = partList(e.locomotion);
            if (parts.length) clause += `, powered by ${listNames(parts)}`;
            push(clause);
        });
    }
    // The quieter state shifts: stats (with their values) and components.
    if (entities.statChanges?.length) {
        (entities.statChanges || []).forEach((s) => {
            const who = displayOrGeneric(s.name, 'an entity');
            const statName = s.statName ? String(s.statName) : 'one of its stats';
            push(`${who} had a stat change in ${statName}${valuePhrase(s.from, s.to)}`);
        });
    }
    if (comps.added?.length) {
        (comps.added || []).forEach((row) => {
            const part = componentTypeName(row?.type ?? row?.componentId);
            const holder = displayOrGeneric(row?.entity, 'an entity');
            if (part) {
                push(`${holder} gained ${article(part)} ${part}`);
            } else {
                push(`${holder} gained a component part`);
            }
        });
    }
    if (comps.removed?.length) {
        (comps.removed || []).forEach((row) => {
            const part = componentTypeName(row?.type ?? row?.componentId);
            const holder = displayOrGeneric(row?.entity, 'an entity');
            if (part) {
                push(`${holder} lost ${article(part)} ${part}`);
            } else {
                push(`${holder} lost a component part`);
            }
        });
    }
    if (comps.changed?.length) {
        (comps.changed || []).forEach((row) => {
            const part = componentTypeName(row?.type ?? row?.componentId);
            const partName = part ? `${article(part)} ${part}` : 'a part';
            const statPhrase = row.statName ? ` in ${String(row.statName)}` : '';
            push(`${partName} had a stat change${statPhrase}${valuePhrase(row.from, row.to)}`);
        });
    }
    // Internal parts (rare) — per-row line when possible.
    (internal.added || []).forEach((row) => {
        const holder = displayOrGeneric(row?.entity, 'someone');
        const part =
            componentTypeName(row?.type) || (row?.type ? String(row.type) : null);
        push(
            part
                ? `${holder} gained an internal part (type ${part})`
                : `${holder} gained an internal part`
        );
    });
    (internal.removed || []).forEach((row) => {
        const holder = displayOrGeneric(row?.entity, 'someone');
        const part =
            componentTypeName(row?.type) || (row?.type ? String(row.type) : null);
        push(
            part
                ? `${holder} lost an internal part (type ${part})`
                : `${holder} lost an internal part`
        );
    });
    // What the room's inhabitants said (verbatim, newest window only).
    (entry.chat?.added || []).forEach((m) => {
        if (!m || typeof m !== 'object') return;
        const raw = String(m.text ?? '');
        const quote = raw.replace(/[\s.!?]+$/, '');
        if (!quote) return;
        const speaker = displayOrGeneric(m.speakerName, 'someone');
        push(`${speaker} said, "${quote}"`);
    });
    return out;
}

/**
 * The first-observation paragraph (a room seen for the first time). Opens with
 * "Initial observation of <room>:" (with the room context suffix) — the
 * phrasing the round-prose contract pins — and describes what is already
 * there: who/what is in the room, machines (as a state fact, not an event),
 * and floor objects (at their display coordinates when known).
 * @param {Object} entry
 * @param {{ rn: string, suffix: string }} roomCtx
 * @returns {string}
 */
function baselineText(entry, roomCtx) {
    const entities = (entry.entities || {}).appeared || [];
    const floor = (entry.dropped || {}).added || [];
    const machines = (entry.machines || {}).placed || [];
    const parts = [];
    const names = entities
        .filter((e) => e && typeof e === 'object' && !e.machine)
        .map((e) => displayOrGeneric(e.name, 'an entity'))
        .filter(Boolean);
    if (names.length) {
        const verb = names.length === 1 ? 'is' : 'are';
        let part = `${listNames(names)} ${verb} in the room`;
        if (names.length === 1) {
            const r = entities.filter((e) => e && typeof e === 'object' && !e.machine)[0];
            if (r != null && (finiteNum(r.x) != null || finiteNum(r.y) != null)) {
                part += ` at ${formatPosition(r.x, r.y)}`;
            }
        }
        parts.push(part);
    }
    parts.push(...machines.map((row) => machineClause(row, 'baseline')).filter(Boolean));
    const floorNames = floor.filter(Boolean).map((r) => prettyItemName(r)).filter(Boolean);
    if (floorNames.length) {
        if (floorNames.length === 1) {
            const r = floor.filter(Boolean)[0];
            const pos =
                r != null && (finiteNum(r.x) != null || finiteNum(r.y) != null)
                    ? ` at ${formatPosition(r.x, r.y)}`
                    : '';
            parts.push(`${floorNames[0]} rests on the floor${pos}`);
        } else {
            parts.push(`${listWithArticles(floorNames)} rest on the floor`);
        }
    }
    const text = parts.length
        ? `Initial observation of ${roomCtx.rn}${roomCtx.suffix}: ${joinChunk(parts)}`
        : `Initial observation of ${roomCtx.rn}${roomCtx.suffix}: nothing notable in the room`;
    return `${text}.`;
}

/**
 * One room, as one paragraph: its delta entries (oldest → newest) turned into
 * flowing narrative sentences. The room is named once, at the front of the
 * first sentence, together with its full context (name, width x height, map
 * position, description — whatever the room record supplies); later sentences
 * continue without repeating it.
 * @param {{ entries: Array|null, roomName: string|null, room: Object|null }} ctx
 *   - entries: the room's delta entry stream (newest last)
 *   - roomName: the room's display name for the paragraph
 *   - room: the full room record (name, description, width/height, map x/y);
 *     every field is optional
 * @returns {string} — '' when the room had nothing worth saying
 */
export function buildRoomProse({ entries = null, roomName = null, room = null } = {}) {
    const context = roomContext(roomName, room);
    const sentences = [];
    let roomNamed = false;
    for (const entry of entries ?? []) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.kind === 'baseline') {
            sentences.push(baselineText(entry, context));
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
            sentences.push(`In ${context.rn}${context.suffix}, ${body}.`);
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
