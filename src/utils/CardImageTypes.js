/**
 * CardImageTypes — which file extensions count as character-card image files.
 *
 * A "card" is an image dropped into `data/cards/` whose metadata side channel
 * carries a character payload; the extension tells the listing which files to
 * consider. Keeping the accepted extensions in one place means the spawn listing
 * and the sidecar store treat the same file set as a card (a file with no
 * payload simply fails to decode and is skipped, so a wrong extension is
 * degrading, not fatal).
 *
 * @module src/utils/CardImageTypes
 */

/**
 * The image extensions that may be a character card. Single source of truth for
 * `readCardFiles` (the spawn listing) and `listCardFileNames` (the sidecar store)
 * so both agree on which on-disk files are candidate cards. Read-only table —
 * do not mutate (T-8).
 */
export const CARD_IMAGE_EXTS = new Set([
    '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'
]);
