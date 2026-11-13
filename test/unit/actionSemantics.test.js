import { describe, it, expect } from 'vitest';
import {
    describeAction,
    describeConsequence,
    CONSEQUENCE_TARGET_WORDS,
} from '../../src/controllers/knowledge/actionSemantics.js';

/**
 * actionSemantics unit tests.
 *
 * The contract under test is a READING: given the data the action registry
 * carries, the viewer must say what the action does, in words, without inventing
 * anything the data does not declare and without dropping what it cannot read.
 * The vocabulary is the engine's own (handler-map types, the dispatcher's closed
 * `target` set, the shared TARGETING_TYPES), so each expectation below names the
 * engine-side fact it mirrors.
 */

describe('actionSemantics', () => {
    describe('describeAction — targeting and narration', () => {
        it('reads every targeting type in the shared vocabulary', () => {
            expect(describeAction({ targetingType: 'spatial' }).targeting).toBe('targets a point in space');
            expect(describeAction({ targetingType: 'component' }).targeting).toBe('targets a component');
            expect(describeAction({ targetingType: 'self_target' }).targeting).toBe('targets the actor itself');
            expect(describeAction({ targetingType: 'none' }).targeting).toBe('needs no target');
        });

        it('shows an unknown targeting type RAW and flagged, never paraphrased', () => {
            // The point of the flag: "no targeting" and "targeting we cannot read"
            // are different claims and must not look the same in the payload.
            expect(describeAction({ targetingType: 'psychic' }))
                .toMatchObject({ targeting: 'psychic', targetingDeclared: false });
        });

        it('reports a read targeting type as declared', () => {
            expect(describeAction({ targetingType: 'component' }))
                .toMatchObject({ targeting: 'targets a component', targetingDeclared: true });
        });

        it('treats an absent or non-string targeting type as nothing declared', () => {
            expect(describeAction({})).toMatchObject({ targeting: null, targetingDeclared: true });
            expect(describeAction({ targetingType: '' })).toMatchObject({ targeting: null, targetingDeclared: true });
            expect(describeAction({ targetingType: 7 })).toMatchObject({ targeting: null, targetingDeclared: true });
        });

        it('passes the declared range through, and null when there is none', () => {
            expect(describeAction({ range: 50 }).range).toBe(50);
            expect(describeAction({ range: '50' }).range).toBeNull();
            expect(describeAction({}).range).toBeNull();
        });

        it('reads the narration phrase and its instrumental form', () => {
            expect(describeAction({
                prose: { verbPhrase: 'cut something', instrumental: { verb: 'cut' } },
            }).narration).toBe('cut something (instrumental: cut)');
        });

        it('omits the instrumental when the act does not declare one', () => {
            expect(describeAction({ prose: { verbPhrase: 'dashed' } }).narration).toBe('dashed');
        });

        it('yields no narration without a verbPhrase (never "did undefined")', () => {
            expect(describeAction({ prose: { targetLink: 'direct' } }).narration).toBeNull();
            expect(describeAction({ prose: 'cut something' }).narration).toBeNull();
            expect(describeAction({}).narration).toBeNull();
        });

        it('survives a missing or malformed definition', () => {
            for (const bad of [undefined, null, 'nope', 42, []]) {
                const summary = describeAction(bad);
                expect(summary.targeting).toBeNull();
                expect(summary.effects).toEqual([]);
                expect(summary.failureEffects).toEqual([]);
            }
        });
    });

    describe('describeConsequence — the party', () => {
        it('names the three parties the dispatcher resolves', () => {
            // Mirrors ConsequenceDispatcher._resolveTargetForConsequence: self |
            // target | entity is the WHOLE vocabulary.
            expect(Object.keys(CONSEQUENCE_TARGET_WORDS).sort()).toEqual(['entity', 'self', 'target']);
            expect(describeConsequence({ type: 'log', target: 'self' }).on).toBe('the acting component');
            expect(describeConsequence({ type: 'log', target: 'target' }).on).toBe('the target');
            expect(describeConsequence({ type: 'log', target: 'entity' }).on).toBe('the acting entity');
        });

        it('returns no party for a target word the dispatcher would reject', () => {
            expect(describeConsequence({ type: 'log', target: 'everywhere' }).on).toBeNull();
            expect(describeConsequence({ type: 'log' }).on).toBeNull();
        });
    });

    describe('describeConsequence — the sentence', () => {
        it('reads the damage channel and the run-time scaling binding', () => {
            const row = describeConsequence({
                type: 'damageComponent',
                target: 'target',
                params: { channel: 'cut', value: ':Physical.sharpness' },
            });
            expect(row.text).toBe('deals cut damage, scaled by Physical.sharpness (resolved at run time)');
            expect(row.on).toBe('the target');
            expect(row.described).toBe(true);
        });

        it('spreads the shotgun count and keeps the multiplied stat readable', () => {
            const row = describeConsequence({
                type: 'damageRandomComponents',
                target: 'target',
                params: { channel: 'impact', value: ':Manipulation.fine_controls*2', count: '3' },
            });
            expect(row.text).toContain('across 3 random spreads');
            expect(row.text).toContain('Manipulation.fine_controls × 2 (resolved at run time)');
        });

        it('says which stat falls, and by how much, without a stray sign', () => {
            expect(describeConsequence({
                type: 'updateComponentStatDelta',
                target: 'self',
                params: { trait: 'Physical', stat: 'sharpness', value: -1 },
            }).text).toBe('lowers Physical.sharpness by 1');
            expect(describeConsequence({
                type: 'updateComponentStatDelta',
                target: 'self',
                params: { trait: 'Physical', stat: 'existence', value: 0.1 },
            }).text).toBe('raises Physical.existence by 0.1');
        });

        it('names the consumed-item shot and where its damage comes from', () => {
            const row = describeConsequence({
                type: 'consumeItemAndDamage',
                target: 'target',
                params: { channel: 'impact', value: 0 },
                damageSource: 'equippedItem.firstChild.volume',
            });
            expect(row.text).toContain('consumes one item stored inside the equipped component');
            expect(row.text).toContain('from the equippedItem.firstChild.volume (resolved at run time)');
        });

        it('reads the door, the machine and the sensitive part', () => {
            expect(describeConsequence({
                type: 'traverseDoor', target: 'entity', params: { door: ':door' },
            }).text).toContain('walks through');
            expect(describeConsequence({
                type: 'placeMachine', target: 'entity', params: { itemType: 'water_pump' },
            }).text).toContain('sets the carried machine water_pump down in the world');
            expect(describeConsequence({
                type: 'retrieveMachine', target: 'entity', params: { machineType: 'water_pump' },
            }).text).toContain('takes the placed machine water_pump back into the inventory');
            expect(describeConsequence({ type: 'stimulateSensitivePart', target: 'target' }).text)
                .toContain('raises the pleasure of the touched sensitive part');
        });

        it('says a chunk is shed and an item is taken or put down', () => {
            expect(describeConsequence({ type: 'dropMaterialChunk', target: 'target' }).text)
                .toBe('sheds a material chunk');
            expect(describeConsequence({ type: 'dropItem', target: 'target' }).text)
                .toContain('puts down the given item');
            expect(describeConsequence({ type: 'pickUpItem', target: 'target' }).text)
                .toContain('takes the targeted item into the inventory');
        });

        it('reads a log message from the TOP level of the consequence', () => {
            // Regression: the message sits beside `level`, not inside `params`.
            // Reading only params reported every log as "(no message declared)".
            const row = describeConsequence({
                type: 'log',
                target: 'entity',
                level: 'warn',
                message: "Action 'cut' failed - sharpness too low to cut.",
            });
            expect(row.text).toBe("records a warn entry: Action 'cut' failed - sharpness too low to cut.");
        });

        it('gives the article the level needs', () => {
            expect(describeConsequence({ type: 'log', level: 'info', message: 'x' }).text)
                .toContain('an info entry');
        });

        it('says "(no message declared)" only when there truly is none', () => {
            expect(describeConsequence({ type: 'log', level: 'info' }).text)
                .toContain('(no message declared)');
        });

        it('reports an undeclared type instead of dressing it up', () => {
            const row = describeConsequence({ type: 'meltIntoSunlight', target: 'target' });
            expect(row.described).toBe(false);
            expect(row.text).toBe('runs the undeclared behavior "meltIntoSunlight"');
            expect(row.on).toBe('the target');
        });

        it('never invents a channel, stat or value the data did not declare', () => {
            expect(describeConsequence({ type: 'damageComponent', target: 'target' }).text)
                .toContain('an unstated channel of damage');
            expect(describeConsequence({ type: 'updateComponentStatDelta', target: 'self' }).text)
                .toContain('an unstated stat');
            expect(describeConsequence({ type: 'damageComponent', params: {} }).text)
                .toContain('resolved at run time');
        });
    });

    describe('describeAction — consequence lists', () => {
        it('reads success and failure lists in order', () => {
            const summary = describeAction({
                consequences: [
                    { type: 'damageComponent', target: 'target', params: { channel: 'cut', value: ':Physical.sharpness' } },
                    { type: 'dropMaterialChunk', target: 'target' },
                ],
                failureConsequences: [{ type: 'log', target: 'entity', level: 'warn', message: 'no' }],
            });
            expect(summary.effects.map((e) => e.type)).toEqual(['damageComponent', 'dropMaterialChunk']);
            expect(summary.failureEffects).toHaveLength(1);
        });

        it('accepts a single consequence object where the data uses a list', () => {
            expect(describeAction({ consequences: { type: 'log', level: 'info', message: 'x' } }).effects)
                .toHaveLength(1);
        });

        it('skips entries with nothing to say and keeps the rest', () => {
            const summary = describeAction({
                consequences: [null, 'nope', [], {}, { type: 'dropMaterialChunk', target: 'target' }],
            });
            expect(summary.effects).toHaveLength(1);
            expect(summary.effects[0].type).toBe('dropMaterialChunk');
        });

        it('is defensive about a non-array failure list of junk', () => {
            expect(describeAction({ failureConsequences: 'warn me' }).failureEffects).toEqual([]);
        });
    });
});
