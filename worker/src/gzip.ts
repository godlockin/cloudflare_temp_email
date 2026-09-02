/**
 * Gzip compression/decompression utilities for D1 BLOB / R2 storage.
 * Uses Web Standard CompressionStream/DecompressionStream (native in CF Workers).
 */

import { RawMailRow } from "./models";

export async function compressText(text: string): Promise<ArrayBuffer> {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Response(stream).arrayBuffer();
}

export async function decompressBlob(buffer: ArrayBuffer): Promise<string> {
    const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
}

/**
 * Resolve the raw email text from either R2, raw_blob (gzip) or raw (plaintext) field.
 */
export async function resolveRawEmail(row: RawMailRow, r2Bucket?: R2Bucket): Promise<string> {
    if (row.raw && row.raw.startsWith('r2:')) {
        const r2Key = row.raw.substring(3);
        if (r2Bucket) {
            try {
                const object = await r2Bucket.get(r2Key);
                if (object) {
                    return await object.text();
                }
            } catch (e) {
                console.error("fetch from R2 failed", e);
            }
        }
    }
    if (row.raw_blob) {
        try {
            // D1 returns BLOB as Array<number>, convert to ArrayBuffer for decompression
            return await decompressBlob(new Uint8Array(row.raw_blob as ArrayLike<number>).buffer);
        } catch (e) {
            console.error("decompressBlob failed, fallback to raw field", e);
            return row.raw ?? '';
        }
    }
    return row.raw ?? '';
}

/**
 * Resolve a single row: decompress raw_blob or fetch from R2 if present, strip raw_blob from result.
 */
export async function resolveRawEmailRow(row: RawMailRow, r2Bucket?: R2Bucket): Promise<RawMailRow> {
    const raw = await resolveRawEmail(row, r2Bucket);
    const { raw_blob: _, ...rest } = row;
    return { ...rest, raw };
}

/**
 * Batch resolve raw emails for list queries using Promise.all.
 */
export async function resolveRawEmailList(rows: RawMailRow[], r2Bucket?: R2Bucket): Promise<RawMailRow[]> {
    return Promise.all(rows.map(row => resolveRawEmailRow(row, r2Bucket)));
}

