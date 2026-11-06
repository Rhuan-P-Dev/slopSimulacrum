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
 *   A caller MAY inject three lookups, each of which says nothing on its own:
 *   `lookOf` (component type -> material look words, so an acting part says what
 *   it looks like) and `verbOf` (action name -> the registry's `prose` block, so
 *   the action says what it did in its own words). They are lookups, not
 *   dependencies, and without them every paragraph is exactly what it was before.
 *   The ACTOR'S BODY needs no resolver: it arrives on the action row (`body`),
 *   recorded by the perception flush, so this module never reads the world.
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
 * A bare UUID — the shape a room id has (`56ebc147-f267-…`). Room rows reference
 * rooms by uid, so without this the prose would echo a room id where a room name
 * belongs, and say something different on every world build (room uids are
 * generated, not stable).
 * @constant
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A hex-ish machine/entity id: "ent-3382b7f0-…", or a bare uuid. True for raw
 * ids, false for human names. `displayOrGeneric` uses it so a raw id is never
 * echoed where a name belongs.
 * @param {string} s
 * @returns {boolean}
 */
function isIdLike(s) {
    const v = typeof s === 'string' ? s.trim() : '';
    if (!v) return false;
    return /^[a-z][a-z0-9]*-[0-9a-f-]{8,}$/i.test(v) || UUID_RE.test(v);
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
 * How a verb joins its target when the action's own data says nothing else:
 * the preposition every performed action has always taken in this prose.
 * @constant
 */
const DEFAULT_TARGET_LINK = 'against';

/**
 * The wording of one performed action: the verb phrase, and how it joins its
 * target.
 *
 * The words come from the ACTION REGISTRY, injected as `verbOf` (an action name
 * -> that action's `prose` block from data/mods/core-actions/actions.json). The
 * hand-written verb table that used to live in this module is gone — an action's
 * wording is a property of the action, so shipping a new action says what it
 * does with data alone, and the registry's `description` (written FOR the actor:
 * "Advance your droid toward a target point using your rolling wheels") never
 * enters the observer's prose, where it would say a human has rolling wheels.
 *
 * `targetLink` is the same data deciding the join: absent keeps the historical
 * " against <target>"; `"direct"` hands the verb the target with no preposition
 * ("Adam touched Ball"); any other string is that preposition. An empty or
 * unknown value falls back to the default, so a half-written data entry cannot
 * silently drop the target out of the sentence.
 *
 * With no resolver, or for an action whose data declares no wording, the clause
 * degrades to "did <action>": the action happened, only its wording is missing.
 * Never a guessed verb.
 *
 * @param {string|null} action - the action registry key, as the attribution row recorded it
 * @param {((action: string) => Object|null)|null} [verbOf] - action name -> its `prose` block
 * @returns {{ phrase: string, link: string }} `link` is the preposition joining
 *   the target, or '' when the verb takes the target directly
 */
function actionWording(action, verbOf = null) {
    const key = action == null ? '' : String(action).trim();
    if (!key) return { phrase: 'acted', link: DEFAULT_TARGET_LINK };
    const prose = typeof verbOf === 'function' ? verbOf(key) : null;
    if (!prose || typeof prose !== 'object') return { phrase: `did ${key}`, link: DEFAULT_TARGET_LINK };
    const phrase = typeof prose.verbPhrase === 'string' && prose.verbPhrase.trim() !== ''
        ? prose.verbPhrase.trim()
        : null;
    if (!phrase) return { phrase: `did ${key}`, link: DEFAULT_TARGET_LINK };
    const declared = typeof prose.targetLink === 'string' ? prose.targetLink.trim() : '';
    const link = declared === 'direct' ? '' : (declared || DEFAULT_TARGET_LINK);
    return { phrase, link };
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

/**
 * Display names from `{ type, id }` part rows, in input order.
 *
 * When a `lookOf` resolver is given and answers for a part's material, the name
 * carries how that part looks: "Male Arm (tan, satin)". The
 * resolver is a lookup injected by the caller (`wiki/decisions/visual-stats.md`);
 * this module still reads no world, so the prose stays a pure reader and stays
 * deterministic. WITHOUT a resolver the output is byte-identical to before — a
 * caller with no material access says exactly what it said yesterday.
 *
 * @param {Array|null} rows
 * @param {((componentType: string) => string|null)|null} [lookOf] - component type -> look words
 * @returns {string[]} display names, each optionally suffixed with its look clause
 */
function partList(rows, lookOf = null) {
    const names = [];
    (rows || []).forEach((row) => {
        if (!row || typeof row !== 'object') return;
        const type = row.type ?? row.id;
        const t = componentTypeName(type);
        if (!t) return;
        const look = typeof lookOf === 'function' ? lookOf(type) : null;
        names.push(typeof look === 'string' && look !== '' ? `${t} (${look})` : t);
    });
    return names;
}

/**
 * One body part as the dossier names it: "Male Arm (left, tan, satin)". Inside
 * the parenthesis the part's own label comes first (WHICH
 * instance — the body has two of most of these), then the look words the
 * material owner supplies. A part with no label and no look says its type alone.
 *
 * The label is spelled out instead of being collapsed into a count ("two Male
 * Arms") because English plurals cannot be derived from a display name without
 * inventing them ("Male Genitals" is already one, "Male Foot" is not "Foots"),
 * and because which side acted is the one anatomical fact the sentence can state
 * truthfully — the same reason `YOUR BODY` in the LLM context carries it.
 *
 * The label arrives already stripped to the part's own segment by the writer
 * (`PerceptionController._ownBodyLabel`): a nail's blueprint chain is
 * "tip_f1_hand_left", and reciting the ancestry would say twice what the name
 * says. "default" is the root's placeholder, not a label, so it never prints.
 *
 * @param {{ type: string, identifier?: string|null }} part - one component of the actor
 * @param {((componentType: string) => string|null)|null} lookOf - component type -> look words
 * @returns {string|null} the label, or null when the type has no display name
 */
function bodyPartLabel(part, lookOf) {
    const type = part && typeof part === 'object' ? part.type : null;
    const label = componentTypeName(type) || (type ? String(type) : null);
    if (!label) return null;
    const bits = [];
    const identifier = part.identifier && typeof part.identifier === 'string'
        ? part.identifier.trim().replace(/_/g, ' ')
        : '';
    if (identifier && identifier !== 'default') bits.push(identifier);
    const look = typeof lookOf === 'function' ? lookOf(type) : null;
    if (typeof look === 'string' && look.trim() !== '') bits.push(look.trim());
    // ", " and never joinChunk: the parenthesis is a list of properties ("left,
    // tan"), and "left and tan" would read as one of them.
    return bits.length ? `${label} (${bits.join(', ')})` : label;
}

/**
 * The dossier clause: who did something, and what they are made of while doing
 * it — "Adam, with Male Central Body (tan, satin), Male Head (top, tan, satin),
 * Male Arm (left, …), Male Arm (right, …), …".
 *
 * Only the SHALLOW parts are named — the ones that hang off the body's own root.
 * A human carries 78 components (eight teeth, twenty nails, ten fingers, ten
 * toes), which is a body chart, not a sentence: read aloud it is ~690 words per
 * actor per round, and the paragraph stops being prose. The deep ones are still
 * on the row (`shallow: false`), so the record stays complete and only the
 * reading is gross-anatomy. A part whose row says nothing about depth is read as
 * shallow — the field is an addition, and a caller that hands a body without it
 * meant every part of it.
 *
 * It is a clause, not a sentence of its own invention: `assemble` still owns how
 * clauses become sentences, and the caller still adds the period. Emitted ONCE
 * per actor per build (the caller's `seen` set), so a round in which one entity
 * acted three times describes its body once.
 *
 * Returns null — nothing, not a placeholder — when the actor's body cannot be
 * read or names no part: a dossier over an empty list would claim a bodiless
 * actor, and the world is not claiming that.
 *
 * @param {string} actor - the actor's display name (already id-guarded)
 * @param {Array<{ type: string, identifier?: string|null, shallow?: boolean }>|null} parts
 * @param {((componentType: string) => string|null)|null} lookOf
 * @returns {string|null}
 */
function dossierClause(actor, parts, lookOf) {
    const labels = [];
    (parts || []).forEach((part) => {
        if (part && part.shallow === false) return;
        const label = bodyPartLabel(part, lookOf);
        if (label) labels.push(label);
    });
    if (!labels.length) return null;
    return `${actor}, with ${joinChunk(labels)}`;
}

/**
 * The dossier clause for the actor of one action row, once per actor per build.
 *
 * The body is not looked up: it is the `body` the ACTION ROW carries — the
 * perception flush records what the actor was built of on the act itself
 * (`PerceptionController._actorBody`), so this module keeps reading no world and
 * a round says the same thing in the tenth re-reading as in the first
 * (`wiki/decisions/action-prose.md`). A row written before that field existed
 * carries no body, and the clause is simply absent — never reconstructed.
 *
 * @param {Object} row - one `actions.performed` row (`body`: `[{ type, identifier }]`)
 * @param {string} actor - the actor's display name as the action clause says it
 * @param {{ seen: Set<string>|null, lookOf: ((componentType: string) => string|null)|null }} resolvers
 * @returns {string|null}
 */
function actorDossier(row, actor, { seen = null, lookOf = null } = {}) {
    if (!seen || !row || typeof row !== 'object') return null;
    // Deduped by whoever identifies the actor in the row: the id when it has one,
    // the display name otherwise (a row that names no id cannot key a body).
    const who = (typeof row.entity === 'string' && row.entity.trim() !== '' ? row.entity : null)
        || (typeof row.name === 'string' && row.name.trim() !== '' ? row.name : null);
    if (!who || seen.has(who)) return null;
    seen.add(who);
    if (!Array.isArray(row.body)) return null;
    return dossierClause(actor, row.body, lookOf);
}

/**
 * A lower-case light clause for the room suffix: "dim light" / "bright light"
 * / "flickering light" / "darkness", optionally coloured when the room carries
 * a lightColor: "dim warm light" / "flickering cold light". Null (so the caller
 * drops the clause) when the level is missing or empty. "dark" maps to
 * "darkness" (a bare adjective would not fit the "<level> light" noun-phrase
 * pattern, and a colour on no light is meaningless); all other levels become
 * "<level> [colour] light".
 * @param {*} level
 * @param {*} color
 * @returns {string|null}
 */
function lightLevelPhrase(level, color) {
    const lv = level && typeof level === 'string' ? level.trim() : '';
    if (!lv) return null;
    const c = color && typeof color === 'string' ? color.trim() : '';
    if (lv === 'dark') return 'darkness';
    return c ? `${lv} ${c} light` : `${lv} light`;
}

/**
 * The fog clause for the room-context prose: "hazy" becomes "a haze",
 * "thick" becomes "thick fog"; "none" or an absent value yields null (so the
 * caller drops the clause). Kept as a function to mirror lightLevelPhrase.
 * @param {*} fog
 * @returns {string|null}
 */
function fogPhrase(fog) {
    const f = fog && typeof fog === 'string' ? fog.trim() : '';
    if (f === 'hazy') return 'a haze';
    if (f === 'thick') return 'thick fog';
    return null;
}

/**
 * Room display name plus the context suffix used by the first sentence:
 * " (20 x 12, map position (4.00, 7.00), a temperature of 18.5, 55% humidity,
 * stale air, dim warm light, a haze, the smell of dust and old oil, and the
 * sound of distant dripping water)". Each part is a lower-case property
 * clause joined by joinChunk. Atmosphere is an optional static block
 * (validated in RoomsController) where each present field becomes one clause.
 * Empty string when no room object (or none of name/width/height/x/y/atmosphere)
 * is supplied. Deterministic; raw id-valued fields are simply skipped.
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
    // Atmosphere (optional static room block): each present field becomes one
    // lower-case property clause.
    const a = r.atmosphere && typeof r.atmosphere === 'object' ? r.atmosphere : {};
    const t = finiteNum(a.temperature);
    if (t != null) parts.push(`a temperature of ${statValue(t)}`);
    const hum = finiteNum(a.humidity);
    if (hum != null) parts.push(`${hum}% humidity`);
    const airQuality = typeof a.airQuality === 'string' ? a.airQuality.trim() : '';
    if (airQuality) parts.push(`${airQuality} air`);
    const level = lightLevelPhrase(a.lightLevel, a.lightColor);
    if (level) parts.push(level);
    const fog = fogPhrase(a.fog);
    if (fog) parts.push(fog);
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
 * @param {((componentType: string) => string|null)|null} [lookOf] - component type -> look words
 * @param {{ verbOf: ((action: string) => Object|null)|null,
 *           seen: Set<string>|null,
 *           dossiers: string[]|null }} [resolvers]
 *   - `verbOf`: action name -> its registry `prose` block (the action's wording)
 *   - `seen`: the actors already dossered in THIS build (one line per actor,
 *     however many times it acted); absent, no dossier clause is written at all
 *   - `dossiers`: out-parameter — a dossier is NOT one of the returned clauses.
 *     It is a sentence about a body, and `assemble` weaves clauses into one
 *     sentence, which would land the body list in the middle of the act
 *     ("…, and Male Leg (frontal right, …), Adam threw a punch"). The caller
 *     collects them here and says each one as its own sentence.
 * @returns {string[]}
 */
function entryClauses(entry, lookOf = null, { verbOf = null, seen = null, dossiers = null } = {}) {
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
        const dossier = actorDossier(a, actor, { seen, lookOf });
        if (dossier && Array.isArray(dossiers)) dossiers.push(dossier);
        const { phrase, link } = actionWording(a?.action, verbOf);
        let clause = `${actor} ${phrase}`;
        const target = targetPhrase(a?.target);
        if (target) clause += link ? ` ${link} ${target}` : ` ${target}`;
        const parts = partList(a?.used, lookOf);
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
 * position, atmosphere — whatever the room record supplies); later sentences
 * continue without repeating it.
 * @param {{ entries: Array|null, roomName: string|null, room: Object|null }} ctx
 *   - entries: the room's delta entry stream (newest last)
 *   - roomName: the room's display name for the paragraph
 *   - room: the full room record (name, width/height, map x/y, atmosphere);
 *     every field is optional
 *   - lookOf: optional component type -> look words resolver (see `partList`);
 *     absent, the paragraph carries no look clause at all
 *   - verbOf: optional action name -> registry `prose` block (see
 *     `actionWording`); absent, an action clause says "did <action>"
 * The dossier clause (`dossierClause`) needs no resolver at all — it reads the
 * `body` the action row itself carries — but it is written only when this call
 * passes a `seen` set, i.e. once per actor per paragraph. Each one is its own
 * sentence, before the act it belongs to, and it does not name the room: the
 * narrative sentence right after it still carries the "In <room>, …" prefix.
 * @returns {string} — '' when the room had nothing worth saying
 */
export function buildRoomProse({ entries = null, roomName = null, room = null, lookOf = null, verbOf = null } = {}) {
    const context = roomContext(roomName, room);
    const sentences = [];
    // One dossier per actor for the whole paragraph (`buildRoomProse` IS one
    // room's round), so an entity that acted three times is described once.
    const seen = new Set();
    let roomNamed = false;
    for (const entry of entries ?? []) {
        if (!entry || typeof entry !== 'object') continue;
        if (entry.kind === 'baseline') {
            sentences.push(baselineText(entry, context));
            roomNamed = true;
            continue;
        }
        const dossiers = [];
        const clauses = entryClauses(entry, lookOf, { verbOf, seen, dossiers });
        // One sentence per actor's body, spoken before anything that actor did.
        for (const dossier of dossiers) sentences.push(`${capitalizeFirst(dossier)}.`);
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
 * The delta buckets an entity can appear in, mirroring `DeltaDiff`'
 * `diffRoomSnapshots` output (the shape owner). Room atmosphere has NO rows at
 * all — `roomContext` derives it from the room record — so an entity paragraph
 * carries no light / fog / temperature line by construction, not by filter.
 * @constant
 */
const ENTITY_BUCKETS = Object.freeze({
    entities: Object.freeze(['appeared', 'despawned', 'moved', 'statChanges']),
    components: Object.freeze(['added', 'removed', 'changed']),
    items: Object.freeze(['added', 'removed']),
    dropped: Object.freeze(['added', 'removed', 'moved']),
    equipped: Object.freeze(['added', 'removed']),
    internal: Object.freeze(['added', 'removed']),
    machines: Object.freeze(['placed', 'retrieved']),
    chat: Object.freeze(['added']),
    actions: Object.freeze(['performed'])
});

/**
 * Which way one row touches this entity, or null when it names nobody (or
 * somebody else). The identity field differs per bucket (`DeltaDiff` owns that
 * shape): an entity or machine row is keyed by its own `id`, a component /
 * item / equipped / internal row by the owning `entity`, a floor row by who
 * dropped it, a chat line by its speaker, an action row by its actor — plus
 * who the action was aimed at and who placed a machine.
 *
 * No false positive is possible on the `id` test: ids are typed (`ent-…` vs
 * `item-…` / `eq-…` / a chat id), and the typed prefixes are disjoint, so a
 * floor item's `id` can never read as an entity id.
 *
 * @param {Object|null} row
 * @param {string} entityId
 * @returns {string|null} 'self' | 'owner' | 'dropper' | 'speaker' | 'placer'
 *   | 'target' | null
 */
function entityIdMatch(row, entityId) {
    if (!row || typeof row !== 'object') return null;
    if (row.id === entityId) return 'self';
    if (row.entity === entityId) return 'owner';
    if (row.ownerId === entityId) return 'dropper';
    if (row.speakerEntityId === entityId) return 'speaker';
    if (row.placedBy === entityId) return 'placer';
    if (row.target && typeof row.target === 'object' && row.target.id === entityId) return 'target';
    return null;
}

/**
 * The entity's own display name as one matched row reports it, or '' when the
 * row carries none. Read only through the match kind, so a row where the entity
 * is the VICTIM cannot donate the attacker's name: an action row's `name` is
 * the actor's, which is this entity exactly when the match came from `entity`.
 * Raw ids never count as names (`displayOrGeneric`).
 * @param {Object} row
 * @param {string} kind - the `entityIdMatch` kind
 * @returns {string}
 */
function entityNameFromRow(row, kind) {
    if (kind === 'target') return displayOrGeneric(row?.target?.name, '');
    if (kind === 'speaker') return displayOrGeneric(row?.speakerName, '');
    if (kind === 'self' || kind === 'owner') return displayOrGeneric(row?.name, '');
    return '';
}

/**
 * The same row with THIS entity's raw id replaced by its display name, so the
 * reused clause builders say "Bolt gained a hand" instead of falling back to
 * their generic ("an entity gained a component part"). Only the field that
 * held this entity's id is touched — a copy, never the caller's row — and the
 * clause builders' own id guard (`displayOrGeneric`) keeps any name that is
 * itself id-shaped out of the text.
 * @param {Object} row
 * @param {string} kind
 * @param {string} entityName
 * @returns {Object}
 */
function withEntityLabel(row, kind, entityName) {
    if (!entityName) return row;
    if (kind === 'owner') return { ...row, entity: entityName };
    if (kind === 'dropper') return { ...row, ownerId: entityName };
    return row;
}

/**
 * The rows of ONE delta entry that name one entity, as an entry-shaped copy the
 * room clause builder (`entryClauses`) already knows how to read.
 *
 * @param {Object} entry - one perception delta entry (baselines carry no rows:
 *   a baseline is a room's state description, not something that happened to
 *   one entity)
 * @param {string} entityId
 * @param {string|null} [entityName] - display name to label the rows with
 * @returns {{ entry: Object, rowCount: number, name: string }} - `name` is the
 *   entity's display name found in these rows ('' when none carries one)
 */
export function selectEntityRows(entry, entityId, entityName = null) {
    const selected = { kind: entry?.kind };
    let rowCount = 0;
    let name = '';
    if (!entry || typeof entry !== 'object' || entry.kind === 'baseline') {
        return { entry: selected, rowCount, name };
    }
    for (const [group, buckets] of Object.entries(ENTITY_BUCKETS)) {
        const source = entry[group];
        if (!source || typeof source !== 'object') continue;
        const kept = {};
        for (const bucket of buckets) {
            const rows = Array.isArray(source[bucket]) ? source[bucket] : [];
            const mine = [];
            for (const row of rows) {
                const kind = entityIdMatch(row, entityId);
                if (!kind) continue;
                if (!name) name = entityNameFromRow(row, kind);
                mine.push(withEntityLabel(row, kind, entityName));
            }
            if (mine.length) {
                kept[bucket] = mine;
                rowCount += mine.length;
            }
        }
        if (Object.keys(kept).length) selected[group] = kept;
    }
    return { entry: selected, rowCount, name };
}

/**
 * One entity's stretch of deltas as prose: only what NAMES it — what it did
 * (against whom, powered by which parts), what was done to it, its stat and
 * component shifts, what it picked up / dropped / equipped / wore, its arrival
 * and departure, and the lines it said. Room atmosphere is absent by
 * construction; rows that name somebody else never appear.
 *
 * The sentences reuse the room narrative's clause builders, so the wording of
 * an event is the same words in both views — this function contributes no
 * phrasing of its own. Deterministic like the rest of the module: no
 * timestamps, no ids in the text.
 *
 * @param {{ entries: Array|null, entityId: string|null, entityName: string|null, lookOf: ((componentType: string) => string|null)|null, verbOf: ((action: string) => Object|null)|null }} ctx
 *   `verbOf` means what it means for `buildRoomProse`; the dossier clause covers
 *   every actor the entity's own rows name (so a victim's paragraph carries its
 *   attacker's body — the same clause the room says, never a different one).
 * @returns {{ text: string, entryCount: number }} - `entryCount` counts the
 *   entries that said something about this entity (the entity counterpart of
 *   the room paragraph's entry count); `text` is '' when nothing named it.
 */
export function buildEntityProse({ entries = null, entityId = null, entityName = null, lookOf = null, verbOf = null } = {}) {
    const who = typeof entityId === 'string' ? entityId.trim() : '';
    const name = typeof entityName === 'string' && entityName.trim() !== '' ? entityName.trim() : null;
    if (!who) return { text: '', entryCount: 0 };
    const sentences = [];
    const seen = new Set();
    let entryCount = 0;
    for (const entry of entries ?? []) {
        if (!entry || typeof entry !== 'object') continue;
        const selected = selectEntityRows(entry, who, name);
        if (!selected.rowCount) continue;
        const dossiers = [];
        const clauses = entryClauses(selected.entry, lookOf, { verbOf, seen, dossiers });
        for (const dossier of dossiers) sentences.push(`${capitalizeFirst(dossier)}.`);
        if (!clauses.length) continue;
        const body = assemble(clauses, { firstWordLower: false });
        if (!body) continue;
        sentences.push(`${capitalizeFirst(body)}.`);
        entryCount += 1;
    }
    return { text: sentences.join(' '), entryCount };
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
