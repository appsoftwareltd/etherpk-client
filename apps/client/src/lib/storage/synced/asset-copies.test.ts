import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteAssetCopies, openAssetCopies } from './asset-copies'

afterEach(async () => {
    await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase('etherpk-assets')
        request.onsuccess = () => resolve()
        request.onerror = () => resolve()
    })
})

const GRAPH = 'graph-1'
const OTHER = 'graph-2'

/** A sealed asset of `size` bytes in `chunks` chunks; the bytes stand in for ciphertext. */
function sealed(size: number, chunks = 1, fill = 1) {
    const per = Math.ceil(size / chunks)
    return {
        encryptedMetadata: `meta-${fill}`,
        chunks: Array.from({ length: chunks }, (_, n) => new Uint8Array(Math.min(per, size - n * per)).fill(fill)),
    }
}

/** A clock the test moves by hand, so "least recently used" is exact. */
function clock() {
    let now = 1_000
    return { now: () => now, tick: (ms = 1_000) => (now += ms) }
}

describe('asset copies kept on this device', () => {
    it('keeps what the server sent for an asset, and reads it back chunk by chunk', async () => {
        const copies = openAssetCopies()
        await copies.keep(GRAPH, 'a1', sealed(10, 2, 7))
        const read = await copies.read(GRAPH, 'a1')
        expect(read?.encryptedMetadata).toBe('meta-7')
        expect(read?.chunks.map((chunk) => [...chunk])).toEqual([[7, 7, 7, 7, 7], [7, 7, 7, 7, 7]])
        expect(await copies.read(GRAPH, 'missing')).toBeNull()
        expect(await copies.read(OTHER, 'a1')).toBeNull()
    })

    it('keeps no copy of an asset larger than the limit for one asset', async () => {
        const copies = openAssetCopies({ maxAssetBytes: 100 })
        await copies.keep(GRAPH, 'big', sealed(101))
        expect(await copies.read(GRAPH, 'big')).toBeNull()
    })

    it('removes the copies used least recently once the kept copies pass the budget', async () => {
        const time = clock()
        const copies = openAssetCopies({ budgetBytes: 250, now: time.now })
        await copies.keep(GRAPH, 'a1', sealed(100, 1, 1))
        time.tick()
        await copies.keep(GRAPH, 'a2', sealed(100, 1, 2))
        time.tick()
        // Reading a1 makes it the most recently used.
        await copies.read(GRAPH, 'a1')
        time.tick()
        await copies.keep(GRAPH, 'a3', sealed(100, 1, 3))

        expect(await copies.read(GRAPH, 'a2')).toBeNull()
        expect(await copies.read(GRAPH, 'a1')).not.toBeNull()
        expect(await copies.read(GRAPH, 'a3')).not.toBeNull()
    })
})

describe('uploads queued on this device', () => {
    it('lists a queued upload for its graph only, and reads it like a kept copy', async () => {
        const copies = openAssetCopies()
        await copies.queue(GRAPH, { assetId: 'q1', size: 6, chunkCount: 1, ...sealed(6, 1, 4) })
        const [queued, ...rest] = await copies.queued(GRAPH)
        expect(rest).toEqual([])
        expect(queued.assetId).toBe('q1')
        expect(queued.size).toBe(6)
        expect(queued.chunkCount).toBe(1)
        expect([...queued.chunks[0]]).toEqual([4, 4, 4, 4, 4, 4])
        expect(await copies.queued(OTHER)).toEqual([])
        expect((await copies.read(GRAPH, 'q1'))?.encryptedMetadata).toBe('meta-4')
    })

    it('never removes a queued upload to stay within the budget, nor one larger than the limit', async () => {
        const copies = openAssetCopies({ budgetBytes: 50, maxAssetBytes: 50 })
        await copies.queue(GRAPH, { assetId: 'q1', size: 100, chunkCount: 1, ...sealed(100) })
        await copies.keep(GRAPH, 'a1', sealed(40))
        expect((await copies.queued(GRAPH)).map((asset) => asset.assetId)).toEqual(['q1'])
    })

    it('becomes a kept copy once sent, which the budget may then remove', async () => {
        const time = clock()
        const copies = openAssetCopies({ budgetBytes: 150, now: time.now })
        await copies.queue(GRAPH, { assetId: 'q1', size: 100, chunkCount: 1, ...sealed(100) })
        await copies.sent(GRAPH, 'q1')
        expect(await copies.queued(GRAPH)).toEqual([])
        expect(await copies.read(GRAPH, 'q1')).not.toBeNull()
        time.tick()
        await copies.keep(GRAPH, 'a1', sealed(100))
        expect(await copies.read(GRAPH, 'q1')).toBeNull()
    })

    it('a kept copy of the same asset does not undo its place in the queue', async () => {
        const copies = openAssetCopies()
        await copies.queue(GRAPH, { assetId: 'q1', size: 6, chunkCount: 1, ...sealed(6) })
        await copies.keep(GRAPH, 'q1', sealed(6))
        expect((await copies.queued(GRAPH)).map((asset) => asset.assetId)).toEqual(['q1'])
    })
})

describe('removing copies', () => {
    it('forgets one asset, or every copy and queued upload of a graph', async () => {
        const copies = openAssetCopies()
        await copies.keep(GRAPH, 'a1', sealed(5))
        await copies.keep(GRAPH, 'a2', sealed(5))
        await copies.queue(GRAPH, { assetId: 'q1', size: 5, chunkCount: 1, ...sealed(5) })
        await copies.keep(OTHER, 'b1', sealed(5))

        await copies.forget(GRAPH, 'a1')
        expect(await copies.read(GRAPH, 'a1')).toBeNull()
        expect(await copies.read(GRAPH, 'a2')).not.toBeNull()

        await deleteAssetCopies(GRAPH)
        expect(await copies.read(GRAPH, 'a2')).toBeNull()
        expect(await copies.queued(GRAPH)).toEqual([])
        expect(await copies.read(OTHER, 'b1')).not.toBeNull()
    })
})
