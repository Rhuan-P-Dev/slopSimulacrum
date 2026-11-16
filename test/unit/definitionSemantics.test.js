/**
 * definitionSemantics unit tests (wiki/subMDs/frontend/knowledge_viewer.md Sec. 12).
 *
 * The Entities section's own module, tested at its own seam. The controller's
 * tests cover the same rules through the payload; these pin the module contract
 * the composition root depends on:
 *
 *   1. The kind list is DERIVED, not hand-listed: every kind of the shared
 *      vocabulary appears except the ones the codex already shows on a tab of
 *      their own — so a registry a mod adds needs no change here to appear.
 *   2. `readDefinitionRegistries` asks the registry source for exactly those
 *      kinds (a kind is named, never a path), and fails fast without one.
 *   3. One row per top-level entry, in every shape the data uses: keyed map,
 *      array of ids, array of `[part, slot]` rows, array of wear claims, a bare
 *      scalar, `null`. Metadata keys are not entries.
 *   4. A reference resolves when this server can name it and keeps its raw key
 *      when it cannot — the reader never invents a name.
 *   5. A row's `definition` is the entry VERBATIM and never the injected object
 *      itself (the payload is handed to every caller).
 *   6. A facet that names an entry of another registry carries that target as a
 *      `part` (`kind` + `id`) — and never a tab, which is the client's fact.
 *
 * @module test/unit/definitionSemantics
 */

import { describe, it, expect } from 'vitest';
import {
    CODEX_TAB_OWNED_KINDS,
    DEFINITION_REGISTRY_KINDS,
    DEFINITION_FAMILY_LIST,
    CODEX_TAB_SECTION_IDS,
    DEFINITION_FALLBACK_FAMILY_ID,
    buildDefinitionGroups,
    ungroupedDefinitionKinds,
    readDefinitionRegistries,
    buildDefinitionRows,
    buildFacets,
} from '../../src/controllers/knowledge/definitionSemantics.js';
import { REGISTRY_KIND_LIST, REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

describe('definitionSemantics — the kind list is derived', () => {
    it('is the shared vocabulary minus the kinds that own a tab', () => {
        expect(DEFINITION_REGISTRY_KINDS).toEqual(
            REGISTRY_KIND_LIST.filter((kind) => !Object.hasOwn(CODEX_TAB_OWNED_KINDS, kind))
        );
    });

    it('excludes exactly the sections the codex already renders', () => {
        expect(Object.keys(CODEX_TAB_OWNED_KINDS).sort()).toEqual([
            'actions', 'crafting', 'inventoryItems', 'materials', 'propertyTraitMapping', 'traits',
        ].sort());
        for (const owned of Object.keys(CODEX_TAB_OWNED_KINDS)) {
            expect(DEFINITION_REGISTRY_KINDS).not.toContain(owned);
        }
    });

    it('lists the world of definitions the four tabs never show', () => {
        for (const kind of [
            REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.BLUEPRINTS, REGISTRY_KINDS.ROOMS,
            REGISTRY_KINDS.WORLD_OBJECTS, REGISTRY_KINDS.NPCS, REGISTRY_KINDS.EFFECTS,
            REGISTRY_KINDS.WORLD_RULES,
        ]) {
            expect(DEFINITION_REGISTRY_KINDS).toContain(kind);
        }
        // The list is the whole remainder: nothing is hidden for want of an entry
        // in this test, and the count is the arithmetic, not a hand-tuned number.
        expect(DEFINITION_REGISTRY_KINDS.length)
            .toBe(REGISTRY_KIND_LIST.length - Object.keys(CODEX_TAB_OWNED_KINDS).length);
    });
});

describe('definitionSemantics — reading the registries', () => {
    it('asks the registry source for exactly the Entities kinds, by name', () => {
        const asked = [];
        const store = { read: (kind) => { asked.push(kind); return { [kind]: { entry: 1 } }; } };
        const registries = readDefinitionRegistries(store);
        expect(asked).toEqual([...DEFINITION_REGISTRY_KINDS]);
        expect(Object.keys(registries)).toEqual([...DEFINITION_REGISTRY_KINDS]);
        expect(registries[REGISTRY_KINDS.COMPONENTS]).toEqual({ components: { entry: 1 } });
    });

    it('fails fast without a source it can read', () => {
        expect(() => readDefinitionRegistries(null)).toThrow(TypeError);
        expect(() => readDefinitionRegistries({})).toThrow(TypeError);
        expect(() => readDefinitionRegistries({ read: 'data/mods' })).toThrow(TypeError);
    });
});

describe('definitionSemantics — one row per entry, in whatever shape the author used', () => {
    const REGISTRIES = {
        components: {
            _comment: 'metadata, never a row',
            _meta: { name: 'also metadata' },
            head: { name: 'Head', form: { volume: 3 } },
            plain: {},
        },
        blueprints: { walker: ['head', ['head', 'left']] },
        outfits: { m1: [{ item: 'knife', component: 'hand' }] },
        // A registry whose entries ARE numbers, alongside one whose entries are rooms.
        sensitiveParts: { head: 90, zero: 0, text: 'massBurden', flag: true },
        rooms: { nul: null, num: 7, start: { name: 'Start', connections: { north: { target: 'cave' } } } },
    };
    const rows = buildDefinitionRows({ registries: REGISTRIES });
    const rowsOf = (kind) => rows.filter((r) => r.kind === kind);

    it('enumerates the derived kind list, not whatever keys the caller passed', () => {
        expect(rowsOf('components').map((r) => r.id)).toEqual(['head']);
        // An empty object and a null define nothing, so they are not entries. A bare
        // number IS kept: the reference drops no entry for the shape of its author
        // (its `value` facet prints it, and the card titles itself with the id).
        expect(rowsOf('components').find((r) => r.id === 'plain')).toBeUndefined();
        expect(rowsOf('rooms').map((r) => r.id)).toEqual(['num', 'start']);
        // A key outside the shared vocabulary contributes nothing: the kind list is
        // the contract (the controller rejects such a key at boot, this reader just
        // has nothing to say about it).
        expect(rows.some((r) => r.kind === 'junk')).toBe(false);
    });

    it('gives the scalar registries a row, because the number IS the entry', () => {
        expect(rowsOf('sensitiveParts').map((r) => r.id)).toEqual(['flag', 'head', 'text', 'zero']);
    });

    it('is total: no registries, no rows; an absent kind contributes nothing', () => {
        expect(buildDefinitionRows()).toEqual([]);
        expect(buildDefinitionRows({ registries: {} })).toEqual([]);
        expect(buildDefinitionRows({ registries: { components: null } })).toEqual([]);
        expect(buildDefinitionRows({ registries: { components: 'not a registry' } })).toEqual([]);
    });

    it('carries the entry verbatim, and never the injected object itself', () => {
        const injected = { name: 'Head', form: { volume: 3 } };
        const [row] = buildDefinitionRows({ registries: { components: { head: injected } } });
        expect(row.definition).toEqual(injected);
        expect(row.definition).not.toBe(injected);
        row.definition.form.volume = 99;
        expect(injected.form.volume).toBe(3);
    });

    it('prints a scalar entry as its own value, 0 included', () => {
        const byId = Object.fromEntries(rowsOf('sensitiveParts').map((r) => [r.id, r]));
        expect(byId.head.facets).toEqual([{ label: 'value', value: '90' }]);
        expect(byId.zero.facets).toEqual([{ label: 'value', value: '0' }]);
        expect(byId.text.facets).toEqual([{ label: 'value', value: 'massBurden' }]);
        expect(byId.flag.facets).toEqual([{ label: 'value', value: 'true' }]);
    });
});

describe('definitionSemantics — references resolve, or keep their raw key', () => {
    const REFERENCES = {
        materials: { iron: { name: 'Iron' } },
        items: { knife: { name: 'Knife' } },
        recipes: { r1: { name: 'Forge Job' } },
    };
    const rows = buildDefinitionRows({
        registries: {
            components: {
                head: {
                    name: 'Head',
                    form: { volume: 3 },
                    materials: [{ material: 'iron', fraction: 1 }, { material: 'ununpentium', fraction: 0.5 }],
                    internalComponents: ['sensor', { type: 'gland' }, 'bogus'],
                },
            },
            internalComponents: { sensor: { name: 'Sensor' }, gland: {} },
            rooms: {
                cave: { name: 'The Cave' },
                start: { name: 'Start', connections: { north: { target: 'cave' }, secret: { target: 'lost_key' } } },
            },
            machines: { forge: { name: 'Forge', blueprint: 'bp_missing', itemKey: 'knife', recipeId: 'r1' } },
            npcs: { guard: { name: 'Guard', room: 'start', initialItems: [{ item: 'spoon', count: 1 }] } },
        },
        references: REFERENCES,
    });
    const facet = (kind, id, label) => rows.find((r) => r.kind === kind && r.id === id)
        .facets.find((f) => f.label === label)?.value ?? null;

    it('names what this server can name', () => {
        expect(facet('components', 'head', 'composition')).toBe('Iron x1, ununpentium x0.5');
        // An organ this server has no entry for keeps the key the author wrote:
        // the reader never invents a name, and never drops the reference either.
        expect(facet('components', 'head', 'organs')).toBe('Sensor, gland, bogus');
        expect(facet('rooms', 'start', 'exits')).toBe('north -> The Cave, secret -> lost_key');
        expect(facet('machines', 'forge', 'item')).toBe('Knife');
        expect(facet('machines', 'forge', 'recipe')).toBe('Forge Job');
        expect(facet('npcs', 'guard', 'room')).toBe('Start');
    });

    it('keeps the raw key when no name exists, and never fabricates one', () => {
        // `bp_missing` is no blueprint here, `spoon` no item: the row says the key.
        expect(facet('machines', 'forge', 'blueprint')).toBe('bp_missing');
        expect(facet('npcs', 'guard', 'carries')).toBe('spoon x1');
    });

    it('works with no lookup tables at all (the reading degrades, it does not throw)', () => {
        const facets = buildFacets(REGISTRY_KINDS.COMPONENTS, {
            name: 'Head', volume: 4, materials: [{ material: 'iron', fraction: 1 }],
        });
        // With no materials table the composition still reads — and nothing in it
        // is a link: a part names a target only when a table proved the entry
        // exists, so the degraded reading cannot offer a jump that lands nowhere.
        expect(facets).toEqual([
            { label: 'volume', value: '4' },
            {
                label: 'composition',
                value: 'iron x1',
                parts: [{ text: 'iron' }, { text: ' x1' }],
            },
        ]);
    });

    it('reads the parts a blueprint hangs on, slot included', () => {
        const built = buildDefinitionRows({
            registries: { blueprints: { rig: ['head', ['arm', 'left'], { type: 'arm', slot: 'right' }] } },
        });
        // No components registry was handed over, so no child resolves and none of
        // them is a link; the slot stays plain text either way.
        expect(built[0].facets).toEqual([{
            label: 'parts',
            value: 'head, arm [left], arm [right]',
            parts: [
                { text: 'head' }, { text: ', ' },
                { text: 'arm' }, { text: ' [left]' },
                { text: ', ' },
                { text: 'arm' }, { text: ' [right]' },
            ],
        }]);
    });
});

describe('definitionSemantics — a resolved reference names its target, never a tab', () => {
    // The tables as the controller hands them over: the world's own registries for
    // the kinds it loads (rooms, components, organs, blueprints), and reference
    // tables only for the kinds the codex renders on tabs of their own.
    const REGISTRIES = {
        components: {
            head: {
                name: 'Head',
                materials: [{ material: 'iron', fraction: 0.7 }, { material: 'wood', fraction: 0.3 }],
                internalComponents: ['strengthCore', { type: 'burner' }],
            },
        },
        internalComponents: { strengthCore: { name: 'Strength Core' } },
        blueprints: { rig: ['head', ['arm', 'left']] },
        outfits: { rig: [{ item: 'hat', component: 'head' }] },
        rooms: { a: { connections: { north: { target: 'b' }, locked: {} } }, b: { name: 'Second' } },
        machines: { forge: { blueprint: 'rig', itemKey: 'hat', recipeId: 'r1' } },
        npcs: { guard: { room: 'a', initialItems: [{ item: 'knife', count: 2 }] } },
        // The entity type links to the blueprint `rig`, which this fixture has.
        entityAttributes: { attributes: { rig: { 'Physical.energy': { value: 100, max: 100, drainPerTurn: 1 } } } },
    };
    const REFERENCES = {
        materials: { iron: { name: 'Iron' } },
        items: { hat: { name: 'Hat' }, knife: { name: 'Knife' } },
        recipes: { r1: { name: 'Forge Job' } },
    };
    const rows = buildDefinitionRows({ registries: REGISTRIES, references: REFERENCES });
    const facet = (kind, id, label) => rows
        .find((row) => row.kind === kind && row.id === id)
        ?.facets.find((f) => f.label === label);
    /** A part as `kind:id=text`, or the bare text when the part links nowhere. */
    const partShape = (part) => (part.kind ? `${part.kind}:${part.id}=${part.text}` : part.text);

    it('links a material to the materials entry, and keeps an unknown one as text', () => {
        expect(facet('components', 'head', 'composition').parts.map(partShape))
            .toEqual(['materials:iron=Iron', ' x0.7', ', ', 'wood', ' x0.3']);
    });

    it('links every organ a part carries, by its own kind', () => {
        expect(facet('components', 'head', 'organs').parts.map(partShape))
            .toEqual(['internalComponents:strengthCore=Strength Core', ', ', 'burner']);
    });

    it('links a blueprint\'s children, and only the garment of a wear claim', () => {
        expect(facet('blueprints', 'rig', 'parts').parts.map(partShape))
            .toEqual(['components:head=Head', ', ', 'arm', ' [left]']);
        // The component a garment mounts on is the author's raw key, never read as
        // a component id — so only the garment half of the sentence is a link.
        expect(facet('outfits', 'rig', 'wears').parts.map(partShape))
            .toEqual(['inventoryItems:hat=Hat', ' on head']);
    });

    it('links the room a door opens onto, and not the door', () => {
        expect(facet('rooms', 'a', 'exits').parts.map(partShape))
            .toEqual(['north -> ', 'rooms:b=Second', ', ', 'locked']);
    });

    it('links a machine\'s three forms, a nameless target under its own key', () => {
        // The blueprint is a real entry that declares no name: the codex titles such
        // a card with its id, so that is what the link says too.
        expect(facet('machines', 'forge', 'blueprint').parts.map(partShape)).toEqual(['blueprints:rig=rig']);
        expect(facet('machines', 'forge', 'item').parts.map(partShape)).toEqual(['inventoryItems:hat=Hat']);
        expect(facet('machines', 'forge', 'recipe').parts.map(partShape)).toEqual(['crafting:r1=Forge Job']);
    });

    it('offers no link against a list-shaped table', () => {
        // A recipe table shaped as a list has no keys the referring data can use
        // (`entriesOf` addresses its rows by declared id or index), so the
        // reference stays visible and plain.
        const listed = buildDefinitionRows({
            registries: { machines: { forge: { recipeId: 'r1' } } },
            references: { recipes: [{ id: 'r1', name: 'Forge Job' }] },
        });
        expect(listed[0].facets[0].parts).toEqual([{ text: 'r1' }]);
    });

    it('links the room an NPC stands in and each item it carries', () => {
        expect(facet('npcs', 'guard', 'room').parts.map(partShape)).toEqual(['rooms:a=a']);
        expect(facet('npcs', 'guard', 'carries').parts.map(partShape)).toEqual(['inventoryItems:knife=Knife', ' x2']);
    });

    it('says the same sentence with and without the links', () => {
        // `value` is the parts' text concatenated, so the search (which reads
        // `value`) and the row (which renders the parts) cannot disagree.
        for (const row of rows) {
            for (const rowFacet of row.facets) {
                expect(rowFacet.value).toBe(rowFacet.parts.map((part) => part.text).join(''));
            }
        }
    });

    it('offers a target, never a tab: a part carries text, kind and id, nothing else', () => {
        for (const row of rows) {
            for (const rowFacet of row.facets) {
                for (const part of rowFacet.parts) {
                    expect(Object.keys(part).sort().join('+')).toMatch(/^(id\+kind\+)?text$/);
                    expect(part.text.length).toBeGreaterThan(0);
                }
            }
        }
    });
});

describe('definitionSemantics — the attributes an entity type owns', () => {
    // The shipped shape: the file wraps its body in `attributes`, and each entry
    // is keyed by ENTITY TYPE, holding the flat "Group.stat" wire form (see
    // data/mods/core-entity-attributes/entityAttributes.json and the reader that
    // consumes it, src/utils/EntityAttributeData.js).
    const REGISTRIES = {
        entityAttributes: {
            _comment: 'metadata, not an entity',
            attributes: {
                m1Droid: {
                    'Physical.energy': { value: 100, max: 100, drainPerTurn: 1 },
                    'Mind.think_level': { value: 3 },
                    'Movement.move': '9',
                    empty: {},
                },
                walker: { 'Physical.energy': { max: 50, drainPerTurn: 2 } },
            },
        },
        blueprints: { m1Droid: ['head'] },
    };
    const rows = buildDefinitionRows({ registries: REGISTRIES });
    const attrRows = rows.filter((r) => r.kind === REGISTRY_KINDS.ENTITY_ATTRIBUTES);
    const rowOf = (id) => attrRows.find((r) => r.id === id);
    const lines = (row) => row.facets.map((f) => `${f.label} = ${f.value}`);
    /** A part as `kind:id=text`, or the bare text when the part links nowhere. */
    const partShape = (part) => (part.kind ? `${part.kind}:${part.id}=${part.text}` : part.text);

    it('splits the holder: one row per entity type, never one for the word itself', () => {
        expect(attrRows.map((r) => r.id)).toEqual(['m1Droid', 'walker']);
        // Each card's raw appendix is that entity type's own declarations, so the
        // appendix no longer has to carry the whole file to say one number.
        expect(rowOf('walker').definition).toEqual({ 'Physical.energy': { max: 50, drainPerTurn: 2 } });
    });

    it('writes one line per attribute, naming only the numbers the entry declared', () => {
        expect(lines(rowOf('m1Droid'))).toEqual([
            'blueprint = m1Droid',
            'Physical.energy = starts 100, cap 100, drains 1 per turn',
            'Mind.think_level = starts 3',
        ]);
        // A drain with no seed still says what it has. A string and an empty object
        // are not attribute declarations, so they get no line (the appendix shows
        // both, and the codex drops no entry — only an unreadable line).
        expect(lines(rowOf('walker'))).toEqual([
            'blueprint = walker',
            'Physical.energy = cap 50, drains 2 per turn',
        ]);
    });

    it('copies the three declared numbers and divides nothing', () => {
        // max / drainPerTurn would say "100 turns"; the codex states declared
        // values and performs no arithmetic the engine does not (Sec. 8).
        const text = rowOf('m1Droid').facets.map((f) => f.value).join(' ');
        expect(text).not.toMatch(/\d+\s*\/\s*\d+|%|~|turns (to|until|left)/);
    });

    it('links the entity type to the blueprint it is keyed by', () => {
        expect(rowOf('m1Droid').facets[0].parts.map(partShape)).toEqual(['blueprints:m1Droid=m1Droid']);
        // `walker` is no blueprint in this fixture: the key stays a plain word, so
        // the card offers no jump that would land on nothing.
        expect(rowOf('walker').facets[0].parts).toEqual([{ text: 'walker' }]);
    });

    it('reads a file authored without the holder, and holds nothing against an empty one', () => {
        const flat = buildDefinitionRows({
            registries: { entityAttributes: { scribe: { 'Physical.energy': { value: 1 } } } },
        });
        expect(flat.map((r) => `${r.id} | ${r.facets[0].value}`)).toEqual(['scribe | scribe']);
        expect(buildDefinitionRows({ registries: { entityAttributes: { attributes: {} } } })).toEqual([]);
    });
});

describe('definitionSemantics - what writes an entity attribute', () => {
    // The two shipped field paths that name an attribute outside the attributes file:
    // an item's `consume.targetStat` (the `eat` action) and an organ's
    // `overTime[].targetStat`; plus the organ's `grants` map, keyed by the same flat
    // stat name. See data/mods/core-inventory-items (apple) and
    // core-internal-components (coalGenerator).
    const build = ({ items = null, organs = null } = {}) => buildDefinitionRows({
        registries: {
            entityAttributes: {
                attributes: {
                    rig: {
                        'Physical.energy': { value: 100, max: 100 },
                        'Pleasure.pleasure': { value: 0, max: 100 },
                    },
                },
            },
            internalComponents: organs,
        },
        references: { items },
    }).find((row) => row.kind === REGISTRY_KINDS.ENTITY_ATTRIBUTES && row.id === 'rig');
    const lines = (row) => row.facets.map((f) => `${f.label} = ${f.value}`);
    /** A part as `kind:id=text`, or the bare text when the part links nowhere. */
    const partShape = (part) => (part.kind ? `${part.kind}:${part.id}=${part.text}` : part.text);

    it('names the items that charge it, and jumps to the item', () => {
        const row = build({
            items: {
                _comment: 'metadata, not an item',
                apple: { name: 'Apple', consume: { targetStat: 'Physical.energy', energyGain: 15 } },
                tshirt: { name: 'T-shirt' },
            },
        });
        expect(lines(row)).toContain('charged by = Apple (+15)');
        const charged = row.facets.find((f) => f.label === 'charged by');
        expect(charged.parts.map(partShape)).toEqual(['inventoryItems:apple=Apple', ' (+15)']);
    });

    it('names the organ that charges it on an interval, with its own numbers', () => {
        const row = build({
            organs: {
                coalGenerator: {
                    name: 'Coal Generator',
                    overTime: [
                        { targetStat: 'Physical.energy', intervalTurns: 5, energyGainPerInterval: 10 },
                        { targetStat: 'Pleasure.pleasure', intervalTurns: 3, energyGainPerInterval: 1 },
                    ],
                },
            },
        });
        // One line per attribute, each naming only the effect that targets it.
        expect(lines(row)).toEqual([
            'blueprint = rig',
            'Physical.energy = starts 100, cap 100',
            'charged by = Coal Generator (every 5 turns, +10)',
            'Pleasure.pleasure = starts 0, cap 100',
            'charged by = Coal Generator (every 3 turns, +1)',
        ]);
    });

    it('reads both tables into one line, items first, each entry listed once', () => {
        const row = build({
            items: { apple: { name: 'Apple', consume: { targetStat: 'Physical.energy', energyGain: 15 } } },
            organs: {
                coalGenerator: {
                    name: 'Coal Generator',
                    overTime: [{ targetStat: 'Physical.energy', intervalTurns: 5, energyGainPerInterval: 10 }],
                },
            },
        });
        expect(lines(row).filter((line) => line.startsWith('charged by'))).toEqual([
            'charged by = Apple (+15), Coal Generator (every 5 turns, +10)',
        ]);
    });

    it('names the organs that grant it, and says nothing when none does', () => {
        const granted = build({
            organs: {
                strengthCore: { name: 'Strength Core', grants: { 'Physical.energy': 50 } },
                moveCore: { name: 'Move Core', grants: { 'Movement.move': 20 } },
                inert: { name: 'Inert lump' },
            },
        });
        expect(lines(granted)).toContain('granted by = Strength Core (+50)');
        // `Pleasure.pleasure` has no grantor here, so no line claims one.
        expect(lines(granted).filter((line) => line.startsWith('granted by'))).toHaveLength(1);
        expect(lines(build({}))).toEqual([
            'blueprint = rig',
            'Physical.energy = starts 100, cap 100',
            'Pleasure.pleasure = starts 0, cap 100',
        ]);
    });

    it('holds a target the row does not own against nothing, and keeps a bare mention', () => {
        const row = build({
            items: {
                potion: { name: 'Potion', consume: { targetStat: 'Other.stat', energyGain: 9 } },
                rock: { name: 'Rock', consume: { targetStat: 'Physical.energy' } },
                broken: { name: 'Broken', consume: 'Physical.energy' },
            },
        });
        // A charge with no number is still the author's claim; a `consume` that is
        // not an object declares nothing.
        expect(lines(row).filter((line) => line.startsWith('charged by'))).toEqual(['charged by = Rock']);
    });
});

describe('definitionSemantics — the family table the tab bar is built from', () => {
    it('names every definition kind exactly once: no kind is ungrouped', () => {
        const named = DEFINITION_FAMILY_LIST.flatMap((family) => family.kinds);
        expect(new Set(named).size).toBe(named.length);
        expect([...named].sort()).toEqual([...DEFINITION_REGISTRY_KINDS].sort());
    });

    it('is the five captions, in bar order', () => {
        expect(DEFINITION_FAMILY_LIST.map((family) => `${family.id}=${family.label}`)).toEqual([
            'parts=Parts', 'blueprints=Blueprints', 'world=World', 'characters=Characters', 'data=Data',
        ]);
        // Where a reader would look for a thing, not where the identifier rhymes:
        // an organ type is a part, a machine is a blueprint, a lever is data.
        expect(DEFINITION_FAMILY_LIST[0].kinds).toEqual([
            REGISTRY_KINDS.COMPONENTS, REGISTRY_KINDS.INTERNAL_COMPONENTS, REGISTRY_KINDS.SENSITIVE_PARTS,
        ]);
        expect(DEFINITION_FAMILY_LIST[2].kinds).toEqual([
            REGISTRY_KINDS.WORLD, REGISTRY_KINDS.ROOMS, REGISTRY_KINDS.WORLD_OBJECTS,
        ]);
    });

    it('groups the whole vocabulary when given no kinds, and a subset when given one', () => {
        const full = buildDefinitionGroups();
        expect(full.map((group) => group.id)).toEqual(['parts', 'blueprints', 'world', 'characters', 'data']);
        expect(full.flatMap((group) => group.kinds).length).toBe(DEFINITION_REGISTRY_KINDS.length);
        // A caller handing over two kinds gets those two, in its own order, under
        // their families - the map is a lookup, not a fixed snapshot.
        const subset = buildDefinitionGroups([REGISTRY_KINDS.ROOMS, REGISTRY_KINDS.EFFECTS]);
        expect(subset.map((group) => `${group.id}:${group.kinds.join('|')}`))
            .toEqual(['parts:', 'blueprints:', 'world:rooms', 'characters:', 'data:effects']);
    });

    it('falls a kind the table does not name into the fallback family, never out of the codex', () => {
        const withAlien = buildDefinitionGroups([...DEFINITION_REGISTRY_KINDS, 'modSomething']);
        const data = withAlien.find((group) => group.id === DEFINITION_FALLBACK_FAMILY_ID);
        expect(data.kinds).toContain('modSomething');
        // One family per id: the fallback is a real family, so the bar never grows
        // a caption nobody wrote.
        expect(new Set(withAlien.map((group) => group.id)).size).toBe(DEFINITION_FAMILY_LIST.length);
        expect(ungroupedDefinitionKinds()).toEqual([]);
        expect(ungroupedDefinitionKinds(['modSomething', REGISTRY_KINDS.ROOMS])).toEqual(['modSomething']);
        expect(ungroupedDefinitionKinds('nope')).toEqual([]);
    });

    it('assigns every codex view tab to exactly one family', () => {
        // The bar shows a view tab inside the family about the same matter, so the
        // five views are placed, not left in a block of their own — and placed
        // once, because the same view in two bands would be two active tabs.
        const named = DEFINITION_FAMILY_LIST.flatMap((family) => family.sections);
        expect(new Set(named).size).toBe(named.length);
        expect([...named].sort()).toEqual([...CODEX_TAB_SECTION_IDS].sort());
    });

    it('puts the matter views with parts, crafting with blueprints, actions with the levers', () => {
        // Where a reader looks for the value of a trait (next to the parts it
        // modifies), for a recipe (next to the blueprint it builds from) and for
        // what an action may do (next to the world's rules).
        expect(DEFINITION_FAMILY_LIST.map((family) => `${family.id}=${family.sections.join('|')}`)).toEqual([
            'parts=traitStats|materials|items',
            'blueprints=recipes',
            'world=',
            'characters=',
            'data=actions',
        ]);
    });

    it('sends the view tabs in the payload groups, and freezes them', () => {
        const full = buildDefinitionGroups();
        // A fresh map per call: a caller pushing a tab into a group it was handed
        // cannot poison the family table the next call reads.
        full[0].sections.push('somewhereElse');
        expect(buildDefinitionGroups()[0].sections).toEqual(['traitStats', 'materials', 'items']);
        // A subset call still carries every view tab: the views exist whether or
        // not the caller handed over kinds, so the bar never loses one.
        const subset = buildDefinitionGroups([REGISTRY_KINDS.ROOMS]);
        expect(subset.map((group) => `${group.id}:${group.sections.length}`))
            .toEqual(['parts:3', 'blueprints:1', 'world:0', 'characters:0', 'data:1']);
    });

    it('refuses a caller that hands it something other than kinds', () => {
        // The table itself is frozen and pinned by the coverage test above (a kind
        // named twice, or a kind the codex shows on its own tab, would break that
        // equality); `buildDefinitionGroups` throws on either as well, so an
        // authoring mistake surfaces at boot instead of drawing a wrong bar.
        expect(() => buildDefinitionGroups('nope')).toThrow(TypeError);
        expect(() => buildDefinitionGroups(undefined)).not.toThrow();
    });
});
