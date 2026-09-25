import { describe, expect, it } from 'vitest'

import { createSaveFileSink, type WritableTarget } from './export-sink'

function fakeWritable() {
    const calls: string[] = []
    const chunks: number[][] = []
    const target: WritableTarget = {
        async write(chunk) {
            calls.push('write')
            chunks.push([...chunk])
        },
        async close() {
            calls.push('close')
        },
        async abort() {
            calls.push('abort')
        },
    }
    return { target, calls, chunks }
}

describe('save-file sink', () => {
    it('opens the writable on the first byte, keeps it open through finish, and commits on hand-over', async () => {
        const { target, calls, chunks } = fakeWritable()
        let opened = 0
        const sink = createSaveFileSink(async () => {
            opened++
            return target
        })
        expect(opened).toBe(0)
        await sink.write(new Uint8Array([1]))
        await sink.write(new Uint8Array([2, 3]))
        expect(opened).toBe(1)
        await sink.finish()
        expect(calls).toEqual(['write', 'write'])
        await sink.handOver('ignored.zip')
        expect(calls).toEqual(['write', 'write', 'close'])
        expect(chunks).toEqual([[1], [2, 3]])
    })

    it('discards by aborting the writable, and writes nothing afterwards', async () => {
        const { target, calls } = fakeWritable()
        const sink = createSaveFileSink(async () => target)
        await sink.write(new Uint8Array([1]))
        await sink.discard()
        expect(calls).toEqual(['write', 'abort'])
        await expect(sink.write(new Uint8Array([2]))).rejects.toThrow(/closed/)
        await sink.handOver('x.zip')
        expect(calls).toEqual(['write', 'abort'])
    })

    it('has nothing to abort or close when no byte was ever written', async () => {
        const { target, calls } = fakeWritable()
        const sink = createSaveFileSink(async () => target)
        await sink.discard()
        expect(calls).toEqual([])
    })
})
