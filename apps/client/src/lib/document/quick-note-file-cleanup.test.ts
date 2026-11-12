import { describe, expect, it, vi } from 'vitest'

import type { GraphAssetTools } from '#lib/storage/fs/asset-orphans.js'
import { assetNameFromRef } from '#lib/storage/fs/asset-store.js'

import type { AssetUsage } from './index-db'
import { type NoteFileCleanupDeps, deleteFilesOfDiscardedNotes } from './quick-note-file-cleanup'

const photo = '![receipt](../assets/receipt.a1b2c3d4.webp)'
const pdf = '[report](../assets/report.e5f6a7b8.pdf)'
const none: AssetUsage = { references: 0, documents: [] }

function deps(over: Partial<NoteFileCleanupDeps> = {}): NoteFileCleanupDeps & { removed: string[] } {
    const removed: string[] = []
    const tools = {
        identify: (ref: string) => assetNameFromRef(ref),
        readyToDeleteBytes: async () => ({ ready: true as const }),
        remove: vi.fn(async (ids: string[]) => {
            removed.push(...ids)
            return ids.length
        }),
    } as unknown as GraphAssetTools
    return { tools, usage: async () => none, noteTexts: () => [], removed, ...over }
}

describe('deleteFilesOfDiscardedNotes', () => {
    it('deletes each file the discarded notes alone referenced, once', async () => {
        const d = deps()
        const deleted = await deleteFilesOfDiscardedNotes([`corner shop\n${photo}\n${pdf}`, photo], d)
        expect(deleted).toEqual(['receipt.a1b2c3d4.webp', 'report.e5f6a7b8.pdf'])
        expect(d.removed).toEqual(deleted)
    })

    it('keeps a file another quick note references', async () => {
        const d = deps({ noteTexts: () => [`kept\n${photo}`] })
        expect(await deleteFilesOfDiscardedNotes([photo, pdf], d)).toEqual(['report.e5f6a7b8.pdf'])
    })

    it('keeps a file a document references', async () => {
        const d = deps({ usage: async (needles) => (needles[0].startsWith('receipt') ? { references: 1, documents: [] } : none) })
        expect(await deleteFilesOfDiscardedNotes([photo, pdf], d)).toEqual(['report.e5f6a7b8.pdf'])
    })

    it('keeps every file while the index cannot answer or the graph is behind its relay', async () => {
        expect(await deleteFilesOfDiscardedNotes([photo], deps({ usage: async () => null }))).toEqual([])
        const behind = deps()
        behind.tools!.readyToDeleteBytes = async () => ({ ready: false, reason: 'behind' })
        expect(await deleteFilesOfDiscardedNotes([photo], behind)).toEqual([])
    })

    it('keeps a file while a protected document went unchecked', async () => {
        const d = deps({ protectedUsage: async () => ({ references: 0, documents: [], locked: 1, unread: 0 }) })
        expect(await deleteFilesOfDiscardedNotes([photo], d)).toEqual([])
    })

    it('does nothing for a note with no files, or a graph with no asset tools', async () => {
        expect(await deleteFilesOfDiscardedNotes(['beans'], deps())).toEqual([])
        expect(await deleteFilesOfDiscardedNotes([photo], deps({ tools: null }))).toEqual([])
    })
})
