import { describe, expect, it } from 'vitest'

import { DEFAULT_LOCK_SETTINGS } from '$lib/document/protection/lock-machine'
import { ProtectionService } from '$lib/document/protection/protection-service'
import { inMemoryProtectionStore } from '$lib/document/protection/protection-store'
import { protectedTextReader } from '$lib/document/protection/protected-text-reader'

import { deleteOrphanedAssets, scanOrphanedAssets } from './asset-orphans'
import { createMemoryDirectoryAdapter } from './memory-adapter'

/** A graph's protection, unlocked, with cheap Argon2id: the cost parameters are proven elsewhere. */
async function unlockedProtection() {
    const service = new ProtectionService({
        store: inMemoryProtectionStore(),
        now: () => 0,
        settings: () => DEFAULT_LOCK_SETTINGS,
        commit: async () => {},
        kdfCost: { m: 8, t: 1, p: 1 },
    })
    await service.enable('correct horse battery staple')
    return service
}

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

    // A protected page's text is ciphertext, so without reading it an image used only there
    // would look "referenced by no document", and deleting it is permanent.
    describe('with a protected document', () => {
        async function withProtectedPage() {
            const adapter = await seededAdapter()
            const service = await unlockedProtection()
            // The only reference to the "orphan" is inside the protected page.
            const text = await service.protectDocument('---\ntitle: Vault\n---\n- ![scan](../assets/orphan.33333333.bin)\n')
            expect(text).not.toContain('orphan.33333333.bin')
            await adapter.write('pages', 'Vault.md', text)
            await adapter.writeBinary('assets', 'unused.44444444.bin', bytes(4))
            return { adapter, service }
        }

        it('offers nothing while a protected document cannot be read, and says how many were held back', async () => {
            const { adapter } = await withProtectedPage()
            const scan = await scanOrphanedAssets(adapter)
            expect(scan.orphans).toEqual([])
            // Both look unused to what the scan could read; neither is offered. With no reader at
            // all (the Graphs page), unlocking here would not help, and the result says so.
            expect(scan.withheld).toEqual({ assets: 2, protectedDocuments: 1, unreadableDocuments: 0, unlockable: false })
            expect(scan.scannedDocuments).toBe(3)
        })

        it('offers nothing while the graph is locked', async () => {
            const { adapter, service } = await withProtectedPage()
            service.lockNow()
            const scan = await scanOrphanedAssets(adapter, { readProtected: protectedTextReader(service) })
            expect(scan.orphans).toEqual([])
            expect(scan.withheld).toEqual({ assets: 2, protectedDocuments: 1, unreadableDocuments: 0, unlockable: true })
        })

        it('reads protected documents while unlocked, so only a truly unused asset is offered', async () => {
            const { adapter, service } = await withProtectedPage()
            const scan = await scanOrphanedAssets(adapter, { readProtected: protectedTextReader(service) })
            expect(scan.orphans).toEqual([{ id: 'unused.44444444.bin', label: 'unused.44444444.bin' }])
            expect(scan.withheld).toBeUndefined()
        })

        it('offers nothing when a document holds a fence it cannot pair', async () => {
            const { adapter, service } = await withProtectedPage()
            await adapter.write('pages', 'Broken.md', '```etherpk-cipher\nAQQAAAGYnot-closed\n')
            const scan = await scanOrphanedAssets(adapter, { readProtected: protectedTextReader(service) })
            expect(scan.orphans).toEqual([])
            expect(scan.withheld).toEqual({ assets: 1, protectedDocuments: 1, unreadableDocuments: 0, unlockable: true })
        })
    })

    it('settles pending writes first, so a reference still in an unsaved buffer counts', async () => {
        const adapter = await seededAdapter()
        const scan = await scanOrphanedAssets(adapter, {
            // What the workspace's settle does: the open editor's buffer reaches the folder.
            settle: async () => {
                await adapter.write('pages', 'Draft.md', '![z](../assets/orphan.33333333.bin)')
            },
        })
        expect(scan.orphans).toEqual([])
    })

    it('fails rather than scan a folder an edit could not reach', async () => {
        const adapter = await seededAdapter()
        await expect(
            scanOrphanedAssets(adapter, { settle: async () => Promise.reject(new Error('Edits to Foo could not be written to the folder yet')) }),
        ).rejects.toThrow('could not be written')
    })

    it('deletes the given assets and reports the count, tolerating already-gone files', async () => {
        const adapter = await seededAdapter()
        const removed = await deleteOrphanedAssets(adapter, ['orphan.33333333.bin', 'never-existed.bin'])
        expect(removed).toBe(1)
        expect(await adapter.exists('assets', 'orphan.33333333.bin')).toBe(false)
        expect(await adapter.exists('assets', 'used.11111111.png')).toBe(true)
    })
})
