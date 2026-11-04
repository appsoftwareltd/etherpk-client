import { describe, expect, it, vi } from 'vitest'

import type { AssetUsage } from '#lib/document/index-db.js'
import { createMemoryDirectoryAdapter } from '#lib/storage/fs/memory-adapter.js'

import { createFolderPdfService, type PdfServiceContext } from './pdf-graph-service'

const FILE = 'garden-guide.a1b2c3d4.pdf'
const HASH = 'a'.repeat(64)

function setup(usage: AssetUsage | null = { references: 0, documents: [] }) {
    const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
    const remove = vi.fn(async () => 1)
    const assetGone = vi.fn()
    const assetRenamed = vi.fn()
    const texts = new Map<string, string>()
    const context: PdfServiceContext = {
        graphId: 'g',
        tools: () => ({ scan: async () => ({ orphans: [], totalAssets: 0, scannedDocuments: 0 }), remove, identify: () => FILE, readyToDeleteBytes: async () => ({ ready: true }) }),
        usage: async () => usage,
        protectedUsage: async () => ({ references: 0, documents: [], locked: 0, unread: 0 }),
        assetGone,
        assetRenamed,
    }
    const store = {
        open: (concept: string) => ({
            getText: () => texts.get(concept) ?? '',
            applyChange: ({ from, to, insert }: { from: number; to: number; insert: string }) => {
                const text = texts.get(concept) ?? ''
                texts.set(concept, text.slice(0, from) + insert + text.slice(to))
            },
            whenLoaded: async () => {},
        }),
    }
    const renamed = vi.fn()
    const service = createFolderPdfService({
        ...context,
        adapter,
        assets: () => ({ renamed }) as never,
        store: () => store as never,
    })
    return { adapter, service, remove, assetGone, assetRenamed, texts, renamed }
}

describe('deleting a PDF from its tab', () => {
    it('removes the file and its state when nothing links to it', async () => {
        const { service, remove, assetGone, adapter } = setup()
        await adapter.write('etherpk', `pdf-${HASH}.json`, '{}')
        expect(await service.deleteAsset(FILE, HASH)).toEqual({ deleted: true })
        expect(remove).toHaveBeenCalledWith([FILE])
        expect(await adapter.exists('etherpk', `pdf-${HASH}.json`)).toBe(false)
        expect(assetGone).toHaveBeenCalledWith(FILE, HASH)
    })

    it('refuses while a Document links to it, and names the Document', async () => {
        const { service, remove } = setup({ references: 1, documents: [{ concept: 'Garden', kind: 'page', references: 1 }] })
        expect(await service.deleteAsset(FILE, HASH)).toEqual({ deleted: false, reason: 'linked', documents: ['Garden'] })
        expect(remove).not.toHaveBeenCalled()
    })

    it('refuses while the graph is still being read', async () => {
        const { service } = setup(null)
        expect(await service.deleteAsset(FILE, HASH)).toMatchObject({ deleted: false, reason: 'not-ready' })
    })
})

describe('renaming a PDF on a folder graph', () => {
    it('moves the file, keeping its hash, and rewrites each link', async () => {
        const { service, adapter, texts, assetRenamed, renamed } = setup({ references: 2, documents: [{ concept: 'Garden', kind: 'page', references: 2 }] })
        await adapter.writeBinary('assets', FILE, new Uint8Array([1, 2, 3]))
        texts.set('Garden', `- [a](../assets/${FILE})\n- [b](../assets/${FILE}#page=2)\n`)
        const answer = await service.renameAsset(FILE, 'Shed Plan.pdf', 'garden-guide.pdf')
        expect(answer).toEqual({ target: 'shed-plan.a1b2c3d4.pdf', name: 'Shed Plan.pdf' })
        expect(await adapter.exists('assets', FILE)).toBe(false)
        expect(await adapter.exists('assets', 'shed-plan.a1b2c3d4.pdf')).toBe(true)
        expect(texts.get('Garden')).toBe('- [a](../assets/shed-plan.a1b2c3d4.pdf)\n- [b](../assets/shed-plan.a1b2c3d4.pdf#page=2)\n')
        expect(assetRenamed).toHaveBeenCalledWith(FILE, 'shed-plan.a1b2c3d4.pdf', 'Shed Plan.pdf')
        expect(renamed).toHaveBeenCalledWith(FILE, 'shed-plan.a1b2c3d4.pdf')
    })

    it('does nothing for the name it already has', async () => {
        const { service, assetRenamed } = setup()
        expect(await service.renameAsset(FILE, 'garden-guide.pdf', 'garden-guide.pdf')).toEqual({ target: FILE, name: 'garden-guide.pdf' })
        expect(assetRenamed).not.toHaveBeenCalled()
    })
})

