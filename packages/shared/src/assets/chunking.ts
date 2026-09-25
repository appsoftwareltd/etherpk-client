/**
 * The asset chunking contract, shared by the Client that uploads and the Sync Server that
 * signs the upload URLs.
 *
 * Shared so that the declared `size` on `POST /api/v1/sync/assets` is not taken on trust: from
 * the contract stated here the server derives exactly how many chunks an asset of a given size
 * has, and exactly how long each chunk's ciphertext must be, and signs that length into each
 * presigned PUT URL.
 *
 * Changing either constant is a protocol change: the Client's chunking and the Server's
 * signed lengths must move together, or every upload fails with an opaque 403.
 */

/** Plaintext bytes per chunk before encryption. */
export const ASSET_CHUNK_PLAINTEXT_BYTES = 4 * 1024 * 1024

/**
 * Fixed bytes `sealSymmetric` adds to a plaintext: an 18 byte envelope header (version,
 * kind, epoch id, nonce) plus the 16 byte AES-GCM tag. See `envelope.ts`, which
 * `envelope-overhead.test.ts` pins this against.
 */
export const SYMMETRIC_ENVELOPE_OVERHEAD_BYTES = 18 + 16

/**
 * How many chunks an asset of `size` plaintext bytes is split into. A zero-byte asset is
 * still one chunk, because it still has an envelope.
 */
export function assetChunkCount(size: number): number {
    return Math.max(1, Math.ceil(size / ASSET_CHUNK_PLAINTEXT_BYTES))
}

/** Plaintext bytes in chunk `index` of an asset of `size` bytes. */
export function assetChunkPlaintextLength(size: number, index: number): number {
    const remaining = size - index * ASSET_CHUNK_PLAINTEXT_BYTES
    if (remaining <= 0) return 0
    return Math.min(ASSET_CHUNK_PLAINTEXT_BYTES, remaining)
}

/**
 * Exact ciphertext bytes chunk `index` must be. This is what the server signs as
 * `Content-Length` into the presigned PUT, so it has to match what the Client produces to
 * the byte.
 */
export function assetChunkCiphertextLength(size: number, index: number): number {
    return assetChunkPlaintextLength(size, index) + SYMMETRIC_ENVELOPE_OVERHEAD_BYTES
}

/** Total ciphertext bytes an asset of `size` occupies in the bucket, across all its chunks. */
export function assetCiphertextBytes(size: number): number {
    return size + assetChunkCount(size) * SYMMETRIC_ENVELOPE_OVERHEAD_BYTES
}
