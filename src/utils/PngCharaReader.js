/**
 * PngCharaReader — reads the embedded character-card payload out of the PNG
 * side channel.
 *
 * A "card" in this project is a PNG image (the art) whose `tEXt`/`iTXt`
 * metadata chunk carries the actual character data: a base64-encoded JSON
 * document (Chub.ai/botbooru `chara_card_v2` spec). The world engine only
 * needs that embedded JSON (name, description, personality, ...) — the pixel
 * data is irrelevant to simulation, so it is deliberately ignored.
 *
 * Why a dedicated utility rather than `DataLoader` or in-controller parsing:
 *   - The payload is not a standalone JSON file; it is byte-embedded inside a
 *     binary PNG's metadata chunk, so a JSON loader cannot reach it.
 *   - PNG chunk parsing (signature check, length/type/data/crc framing,
 *     `tEXt`/`iTXt` value extraction) is pure input parsing — it has no world
 *     state and is cleanly testable in isolation from the controller that
 *     spawns from it.
 *   - Keeping it out of the controller obeys the data-loading standard: the
 *     controller never does raw file I/O for its card data; it just asks this
 *     reader for a decoded payload.
 *
 * @module PngCharaReader
 */

import fs from 'node:fs';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];
const BASE64_SAFE = /^[A-Za-z0-9+\/=\s]+$/;

/**
 * Walks the byte buffer, yielding each chunk's `{ type, data }`. The caller
 * never sees the raw art (IDAT) bytes in the return value except as the `data`
 * of every chunk — but we only *look at* `tEXt`/`iTXt`/`IHDR`/`IEND`, so the
 * payload path never touches the art.
 *
 * @param {Buffer} buffer - The full PNG file bytes.
 * @returns {Array<{type: string, data: Buffer}>} All well-formed chunks.
 * @throws {Error} When the file is not a PNG (bad or missing signature) or
 *                the buffer is too short to contain a chunk frame.
 */
function parseChunks(buffer) {
    if (buffer.length < 8) {
        throw new Error('Buffer too short to be a PNG');
    }
    for (let i = 0; i < 4; i += 1) {
        if (buffer[i] !== PNG_SIGNATURE[i]) {
            throw new Error('Not a PNG: missing or corrupted signature');
        }
    }
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= buffer.length) {
        const length = buffer.readUInt32BE(offset);
        const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
        const chunkEnd = offset + 8 + length + 4;
        if (chunkEnd > buffer.length) {
            break; // truncated tail chunk; stop gracefully
        }
        chunks.push({ type, data: buffer.subarray(offset + 8, offset + 8 + length) });
        offset = chunkEnd;
        if (type === 'IEND') {
            break;
        }
    }
    return chunks;
}

/**
 * Extracts `{ keyword, values }` from a `tEXt` or `iTXt` chunk.
 *
 * `tEXt` layout: `keyword \0 value` (C-string keyword, then the raw value bytes).
 * `iTXt` layout: `keyword \0 compression(1 byte) ...value`. Some writers insert
 * a charset field; a couple of candidate value slices are emitted so the
 * caller can try each and keep the one that decodes to JSON.
 *
 * @private
 * @param {Buffer} data - The chunk's data field.
 * @param {string} type - The chunk type, `tEXt` or `iTXt`.
 * @returns {{keyword: string, values: string[]}[]}
 */
function extractTexts(data, type) {
    const out = [];
    try {
        // `latin1` maps byte->char 1:1 so we can locate the null byte by index
        // without any multibyte ambiguity, then slice the ASCII/base64 value
        // (base64 is ASCII) out of the binary-safe slice.
        const raw = data.toString('latin1');
        const nullIdx = raw.indexOf('\0');
        if (nullIdx < 0 || nullIdx > 79) {
            return out; // no delimiter, or a malformed keyword (>79 bytes)
        }
        const keyword = raw.slice(0, nullIdx);
        if (keyword === '') {
            return out;
        }
        const tail = raw.slice(nullIdx + 1);
        if (type === 'tEXt') {
            out.push({ keyword, values: [tail] });
        } else if (type === 'iTXt') {
            // With compression method byte, or without, or with a charset —
            // emit each candidate so the decoder can pick the right one.
            out.push({ keyword, values: [tail, tail.slice(1)] });
        }
    } catch (error) {
        // A malformed metadata chunk must never crash a spawn; just yield no
        // texts so the payload falls through to `success: false`.
        return out;
    }
    return out;
}

/**
 * Decodes a candidate `tEXt`/`iTXt` value (base64) into the character-card
 * `data` object. Returns the card object, or `null` when the value is not a
 * decodable character payload.
 *
 * The `chara_card_v2` spec nests the character under a `data` key (with a
 * top-level `spec`/`spec_version`). A handful of cards ship the flat object
 * directly; both shapes are accepted. Only the fields the world cares about
 * (`name`, `personality`, `description`) need to be present — the rest
 * (avatar, tags, extensions, chub/botbooru metadata) is intentionally
 * *not* used by the engine.
 *
 * @private
 * @param {string} value - The raw chunk value (possibly base64).
 * @returns {{name: string, personality?: string, description?: string}|null}
 */
function decodeCandidate(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (trimmed.length < 4 || !BASE64_SAFE.test(trimmed)) {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(Buffer.from(trimmed, 'base64').toString('utf8'));
    } catch {
        return null;
    }
    if (parsed === null || typeof parsed !== 'object') {
        return null;
    }
    const card = parsed.data && typeof parsed.data === 'object' && typeof parsed.data.name === 'string'
        ? parsed.data
        : (typeof parsed.name === 'string' ? parsed : null);
    if (card && typeof card.name === 'string') {
        return card;
    }
    return null;
}

/**
 * Reads a Chub.ai/botbooru character PNG from disk and returns the embedded
 * character payload (name, personality, description, ...) or `null` if the
 * file is not a PNG or carries no character data.
 *
 * @param {string} filePath - Absolute (or process-relative) path to the PNG.
 * @returns {{ success: boolean, card: {name: string, personality?: string, description?: string}|null, error?: string }}
 */
export function readCharaCard(filePath) {
    let buffer;
    try {
        buffer = fs.readFileSync(filePath);
    } catch (error) {
        return { success: false, card: null, error: `Could not read card file: ${error.message}` };
    }
    let chunks;
    try {
        chunks = parseChunks(buffer);
    } catch (error) {
        return { success: false, card: null, error: error.message };
    }

    const texts = [];
    for (const chunk of chunks) {
        if (chunk.type === 'tEXt' || chunk.type === 'iTXt') {
            texts.push(...extractTexts(chunk.data, chunk.type));
        }
    }

    // Order of attempts: the `chara` keyword first (the canonical card
    // metadata), then every other metadata chunk. The first value that decodes
    // to a character object wins; an image that merely has non-card `tEXt`
    // metadata (e.g. author, source URL) simply falls through to
    // `success: false`.
    const ordered = [
        ...(texts.find((t) => t.keyword && t.keyword.toLowerCase() === 'chara') ? [texts.find((t) => t.keyword && t.keyword.toLowerCase() === 'chara')] : []),
        ...texts.filter((t) => !(t.keyword && t.keyword.toLowerCase() === 'chara'))
    ];
    for (const { values } of ordered) {
        for (const value of values) {
            const card = decodeCandidate(value);
            if (card !== null) {
                return { success: true, card };
            }
        }
    }
    return { success: false, card: null, error: 'No character payload found in the PNG metadata side channel.' };
}
