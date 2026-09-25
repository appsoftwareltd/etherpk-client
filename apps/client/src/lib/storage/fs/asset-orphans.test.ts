import { describe, expect, it } from 'vitest'

import { deleteOrphanedAssets, scanOrphanedAssets } from './asset-orphans'
import { createMemoryDirectoryAdapter } from './memory-adapter'

const bytes = (...values: number[]) => new Uint8Array(values)

async function seededAdapter() {
    const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
    await adapter.ensureSkeleton()
    await adapter.writeBinary('assets', 'used.11111111.png', bytes(1))
    await adapter.writeBinary('assets', 'spaced name.22222222.png', bytes(2))
    await adapter.writeBinary('assets', 'orphan.33333333.bin', bytes(3))
    await adapter.write('journals', '2026-07-16.md', 'see ![x](../assets/used.11111111.png)')
    // Percent-encoded reference (the editor encodes spaces in refs).
    await adapter.write('pages', 'Foo.md', '![y](../assets/spaced%20name.22222222.png)')
    return adapter
}

describe('scanOrphanedAssets (filesystem)', () => {
    it('finds only assets referenced by no document, encoded refs included', async () => {
        const adapter = await seededAdapter()
        const scan = await scanOrphanedAssets(adapter)
        expect(scan.totalAssets).toBe(3)
        expect(scan.scannedDocuments).toBe(2)
        expect(scan.orphans).toEqual([{ id: 'orphan.33333333.bin', label: 'orphan.33333333.bin' }])
    })

    it('counts a reference inside a code fence as a reference (conservative)', async () => {
        const adapter = await seededAdapter()
        await adapter.write('pages', 'Fenced.md', '```\n../assets/orphan.33333333.bin\n```')
        expect((await scanOrphanedAssets(adapter)).orphans).toEqual([])
    })

    it('returns an empty scan for a graph with no assets', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
        await adapter.ensureSkeleton()
        expect(await scanOrphanedAssets(adapter)).toEqual({ orphans: [], totalAssets: 0, scannedDocuments: 0 })
    })

    it('deletes the given assets and reports the count, tolerating already-gone files', async () => {
        const adapter = await seededAdapter()
        const removed = await deleteOrphanedAssets(adapter, ['orphan.33333333.bin', 'never-existed.bin'])
        expect(removed).toBe(1)
        expect(await adapter.exists('assets', 'orphan.33333333.bin')).toBe(false)
        expect(await adapter.exists('assets', 'used.11111111.png')).toBe(true)
    })
})
