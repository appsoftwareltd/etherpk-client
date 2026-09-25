import { describe, expect, it } from 'vitest'
import {
    ASSET_CHUNK_PLAINTEXT_BYTES as CHUNK,
    SYMMETRIC_ENVELOPE_OVERHEAD_BYTES as OVERHEAD,
    assetChunkCiphertextLength,
    assetChunkCount,
    assetChunkPlaintextLength,
    assetCiphertextBytes,
} from './chunking'

describe('assetChunkCount', () => {
    it('splits on the chunk boundary', () => {
        expect(assetChunkCount(CHUNK)).toBe(1)
        expect(assetChunkCount(CHUNK + 1)).toBe(2)
        expect(assetChunkCount(CHUNK * 3)).toBe(3)
    })

    it('gives a zero-byte asset one chunk, because it still has an envelope', () => {
        expect(assetChunkCount(0)).toBe(1)
    })
})

describe('assetChunkPlaintextLength', () => {
    it('fills every chunk but the last', () => {
        const size = CHUNK * 2 + 100
        expect(assetChunkPlaintextLength(size, 0)).toBe(CHUNK)
        expect(assetChunkPlaintextLength(size, 1)).toBe(CHUNK)
        expect(assetChunkPlaintextLength(size, 2)).toBe(100)
    })

    it('is zero past the end', () => {
        expect(assetChunkPlaintextLength(100, 1)).toBe(0)
    })
})

describe('assetChunkCiphertextLength', () => {
    it('adds the envelope overhead to each chunk', () => {
        expect(assetChunkCiphertextLength(1024, 0)).toBe(1024 + OVERHEAD)
        expect(assetChunkCiphertextLength(0, 0)).toBe(OVERHEAD)
    })

    it('is what a small asset must be signed for, byte for byte', () => {
        // The number the presigned PUT binds. If this drifts from what the Client produces,
        // every upload fails as an opaque 403.
        expect(assetChunkCiphertextLength(1024, 0)).toBe(1058)
    })
})

describe('assetCiphertextBytes', () => {
    it('counts one envelope per chunk', () => {
        expect(assetCiphertextBytes(1024)).toBe(1024 + OVERHEAD)
        expect(assetCiphertextBytes(CHUNK * 2)).toBe(CHUNK * 2 + 2 * OVERHEAD)
    })

    it('agrees with summing the chunks individually', () => {
        const size = CHUNK * 3 + 7
        const summed = Array.from({ length: assetChunkCount(size) }, (_, n) =>
            assetChunkCiphertextLength(size, n),
        ).reduce((total, length) => total + length, 0)
        expect(assetCiphertextBytes(size)).toBe(summed)
    })
})
