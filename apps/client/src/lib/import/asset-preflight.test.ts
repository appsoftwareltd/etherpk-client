import { describe, expect, it } from 'vitest'

import { describeOversize, oversizeAssets } from './asset-preflight'
import type { SourceFile } from './types'

function file(path: string, bytes: number): SourceFile {
    return { path, data: new Blob([new Uint8Array(bytes)]) }
}

const limits = { assetBytes: 1024, assetChunks: 128 }

describe('asset pre-flight', () => {
    it('names the files the account cannot store, and leaves the rest alone', () => {
        const oversize = oversizeAssets(
            [file('assets/small.png', 512), file('assets/big.mp4', 2048), file('pages/Note.md', 4096)],
            limits,
        )

        expect(oversize).toEqual([{ path: 'assets/big.mp4', bytes: 2048, reason: 'size' }])
    })

    it('ignores markdown, which travels as encrypted updates rather than as an asset', () => {
        expect(oversizeAssets([file('pages/Huge.md', 10 * 1024)], limits)).toEqual([])
    })

    it('catches a file the chunk allowance refuses even when its size passes', () => {
        // 8 MiB is two 4 MiB chunks: within assetBytes here, but over a one-chunk allowance.
        const oversize = oversizeAssets([file('assets/two-chunks.bin', 8 * 1024 * 1024)], {
            assetBytes: 100 * 1024 * 1024,
            assetChunks: 1,
        })

        expect(oversize).toEqual([expect.objectContaining({ reason: 'chunks' })])
    })

    it('describes a file the way the dialog shows it', () => {
        expect(describeOversize({ path: 'assets/holiday.mp4', bytes: 312 * 1024 * 1024, reason: 'size' }))
            .toBe('holiday.mp4 (312 MB)')
    })
})
