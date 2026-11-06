/**
 * CONTRACT TEST — material look: a material's numbers, spoken.
 *
 * `visual` (data/mods/core-materials/materials.json) is appearance as data, and
 * the English word is DERIVED from it, never authored beside it — so this file
 * pins both halves of that promise, plus the one boundary that matters most:
 * a look must never touch matter.
 *
 *   - vocabulary: each shipped material names itself from its own numbers
 *     (wood "brown, rough, grained", iron "grey, brushed metal", coal
 *     "near-black, coarse, with a faint grain", flesh "tan, satin") — the words a
 *     renderer and the prose will agree on;
 *   - naming law: light red is pink, dark orange is brown, mid orange is tan,
 *     low saturation is grey, hue wraps at 360, and nothing readable means no look
 *     at all (the caller drops the clause rather than inventing one);
 *   - composition: the DOMINANT material names the part — a 60%-iron knife is
 *     "brushed metal", not an average of iron and wood;
 *   - edge validation (`T-1`): a malformed block, an out-of-range number or an
 *     unknown key fails boot loudly, because a typo that silently names nothing
 *     is the dead data the material system exists to prevent;
 *   - the boundary: `derive()` is byte-identical with and without the visual
 *     blocks, so appearance cannot move combat even by accident.
 *
 * @module test/contract/materialLook
 */

import { describe, it, expect } from 'vitest';
import { describeVisual, narrowVisualBlock } from '../../src/utils/materialLook.js';
import MaterialController from '../../src/controllers/materials/MaterialController.js';
import DataLoader from '../../src/utils/DataLoader.js';
import { REGISTRY_KINDS } from '../../shared/RegistryKinds.js';

/** The shipped materials, read through the seam exactly as the server reads them. */
const materials = DataLoader.loadRegistry(REGISTRY_KINDS.MATERIALS);
const mapping = DataLoader.loadJsonSafe('data/mods/core-property-trait-mapping/propertyTraitMapping.json', {});

const controller = new MaterialController(materials, mapping);

/** The same world data with every `visual` block stripped (the before-state). */
function materialsWithoutLook() {
    const stripped = structuredClone(materials);
    for (const entry of Object.values(stripped)) delete entry.visual;
    return stripped;
}

describe('materialLook - the vocabulary of a material', () => {
    it('names each shipped material from its own numbers', () => {
        expect(controller.describeMaterialLook('wood')).toBe('brown, rough, grained');
        expect(controller.describeMaterialLook('iron')).toBe('grey, brushed metal');
        expect(controller.describeMaterialLook('coal')).toBe('near-black, coarse, with a faint grain');
        // Skin: the weighted mean of the American population (hue 24, lightness
        // 58), and NOT translucent - light does not pass through a shoulder.
        expect(controller.describeMaterialLook('flesh')).toBe('tan, satin');
    });

    it('speaks English ASCII only (the committed-tree language policy)', () => {
        for (const id of Object.keys(materials)) {
            const phrase = controller.describeMaterialLook(id);
            expect(phrase, `${id} has a look`).toBeTruthy();
            expect(phrase, `${id}: ASCII only`).toMatch(/^[\x20-\x7E]+$/);
        }
    });

    it('follows the naming law: pink, brown, grey, near-black, and a wrapping wheel', () => {
        expect(describeVisual({ hue: 0, saturation: 90, lightness: 30 }).color).toBe('dark red');
        expect(describeVisual({ hue: 0, saturation: 40, lightness: 70 }).color).toBe('pale pink');
        expect(describeVisual({ hue: 32, saturation: 45, lightness: 40 }).color).toBe('brown');
        // Tan is the third word English builds that the wheel does not: mid orange
        // is a tan, never an "orange". The band is where skin lives, and it is
        // pinned at both edges so a nudge cannot silently rename every human.
        expect(describeVisual({ hue: 24, saturation: 42, lightness: 58 }).color).toBe('tan');
        expect(describeVisual({ hue: 32, saturation: 45, lightness: 52 }).color).toBe('brown');
        expect(describeVisual({ hue: 24, saturation: 42, lightness: 53 }).color).toBe('tan');
        expect(describeVisual({ hue: 24, saturation: 42, lightness: 66 }).color).toBe('tan');
        expect(describeVisual({ hue: 24, saturation: 42, lightness: 67 }).color).toBe('pale orange');
        // Tan names its own lightness, so it takes no modifier: no "pale tan", and
        // saturation cannot shout it into a "vivid tan".
        expect(describeVisual({ hue: 24, saturation: 90, lightness: 58 }).color).toBe('tan');
        expect(describeVisual({ hue: 24, saturation: 42, lightness: 65 }).color).toBe('tan');
        expect(describeVisual({ hue: 200, saturation: 5, lightness: 80 }).color).toBe('grey');
        expect(describeVisual({ hue: 200, saturation: 4, lightness: 94 }).color).toBe('near-white');
        expect(describeVisual({ hue: 30, saturation: 80, lightness: 5 }).color).toBe('near-black');
        // Hue wraps: 360 degrees IS 0 degrees, and a saturated mid-blue is vivid.
        expect(describeVisual({ hue: 360, saturation: 40, lightness: 70 }).color)
            .toBe(describeVisual({ hue: 0, saturation: 40, lightness: 70 }).color);
        expect(describeVisual({ hue: 220, saturation: 80, lightness: 45 }).color).toBe('vivid blue');
    });

    it('says nothing when there is nothing to say', () => {
        expect(describeVisual(null)).toBeNull();
        expect(describeVisual(undefined)).toBeNull();
        expect(describeVisual([])).toBeNull();
        expect(describeVisual({})).toBeNull();
        expect(describeVisual({ grain: 10, translucency: 4 })).toBeNull();   // below every band
        expect(controller.describeMaterialLook('no-such-material')).toBeNull();
    });

    it('names the DOMINANT material of a composition, not an average of it', () => {
        const knife = [{ material: 'iron', fraction: 0.6, role: 'blade' }, { material: 'wood', fraction: 0.4, role: 'handle' }];
        // The blade is what a knife looks like. Averaging the numbers first would
        // answer "blue" for a knife, which is the failure this rule exists to avoid.
        expect(controller.describeCompositionLook(knife)).toBe('grey, brushed metal');
        // A tie keeps the first entry (the same documented tie-break the damage chip
        // uses, so the look and the chip can never name different materials).
        expect(controller.describeCompositionLook([{ material: 'wood', fraction: 0.5 }, { material: 'iron', fraction: 0.5 }]))
            .toBe('brown, rough, grained');
        expect(controller.describeCompositionLook([])).toBeNull();
        expect(controller.describeCompositionLook(null)).toBeNull();
    });
});

describe('materialLook - narrowed once, at the edge', () => {
    it('refuses a malformed visual block, an unknown key, or a number out of range', () => {
        const base = { iron: { name: 'Iron', density: 7.8, properties: { cutResistance: 80 } } };
        expect(() => new MaterialController({ iron: { ...base.iron, visual: 'shiny' } }, mapping))
            .toThrow(/"visual" must be an object of numbers/);
        expect(() => new MaterialController({ iron: { ...base.iron, visual: { shimmer: 10 } } }, mapping))
            .toThrow(/unknown visual key "shimmer"/);
        expect(() => new MaterialController({ iron: { ...base.iron, visual: { hue: 400 } } }, mapping))
            .toThrow(/visual "hue" must be a number in \[0, 360\]/);
        expect(() => new MaterialController({ iron: { ...base.iron, visual: { roughness: 'glossy' } } }, mapping))
            .toThrow(/visual "roughness" must be a number in \[0, 100\]/);
    });

    it('narrows through ONE rule, whichever owner authored the block', () => {
        // Materials and item recipes share this edge: the vocabulary and the rule that
        // accepts it are the same claim, and a garment could not be read against a
        // different list than a material is named from.
        expect(narrowVisualBlock(undefined, 'Item "tshirt"')).toBeNull();
        const visual = { hue: 0, roughness: 62 };
        const narrowed = narrowVisualBlock(visual, 'Item "tshirt"');
        expect(narrowed).toEqual(visual);
        expect(narrowed, 'a copy, never the caller\'s object').not.toBe(visual);
        // The message names whose data broke, so a boot failure says where to look.
        expect(() => narrowVisualBlock({ shimmer: 1 }, 'Item "tshirt"'))
            .toThrow(/^Item "tshirt": unknown visual key "shimmer"/);
        expect(() => narrowVisualBlock({ hue: 'red' }, 'Item "tshirt"'))
            .toThrow(/^Item "tshirt": visual "hue" must be a number in \[0, 360\]/);
        expect(() => narrowVisualBlock('shiny', 'Material "iron"'))
            .toThrow(/^Material "iron": "visual" must be an object of numbers/);
        // A null block is a present, malformed one — absence is `undefined`.
        expect(() => narrowVisualBlock(null, 'Item "tshirt"'))
            .toThrow(/^Item "tshirt": "visual" must be an object of numbers/);
    });

    it('treats an absent visual block as "no look", not as a broken world', () => {
        const bare = new MaterialController(materialsWithoutLook(), mapping);
        expect(bare.describeMaterialLook('iron')).toBeNull();
        expect(bare.describeCompositionLook([{ material: 'iron', fraction: 1 }])).toBeNull();
    });

    it('hands out defensive copies, never its own table', () => {
        const look = controller.getMaterialVisual('flesh');
        look.lightness = 0;
        expect(controller.getMaterialVisual('flesh').lightness).toBe(materials.flesh.visual.lightness);
    });
});

describe('materialLook - appearance never moves matter', () => {
    it('derives byte-identical stats with and without the visual blocks', () => {
        const withoutLook = new MaterialController(materialsWithoutLook(), mapping);
        const blueprints = [
            { form: { volume: 18 }, materials: [{ material: 'flesh', fraction: 1 }] },
            { form: { volume: 6 }, materials: [{ material: 'iron', fraction: 0.6 }, { material: 'wood', fraction: 0.4 }] },
            { form: { volume: 1 }, materials: [{ material: 'coal', fraction: 1 }] },
        ];
        blueprints.forEach((blueprint, index) => {
            expect(controller.derive(blueprint), `blueprint ${index} changed because of a LOOK field`)
                .toEqual(withoutLook.derive(blueprint));
        });
    });
});
