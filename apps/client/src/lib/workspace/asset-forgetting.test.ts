import { describe, expect, it, vi } from 'vitest'

import { sha256 } from '#lib/crypto/digest.js'
import { filesystemAssetTools, type GraphAssetTools } from '#lib/storage/fs/asset-orphans.js'
import { createMemoryDirectoryAdapter } from '#lib/storage/fs/memory-adapter.js'

import { closedFolderForgetting, forgettingAssetTools, forgetFolderState, forgetSyncedState, targetsOfAsset } from './asset-forgetting'

const BYTES = new TextEncoder().encode('a pump manual')
const hashOf = async (bytes: Uint8Array) => [...(await sha256(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('')

function toolsOver(remove: GraphAssetTools['remove'], hashesOf?: GraphAssetTools['hashesOf']): GraphAssetTools {
    return { scan: async () => ({ orphans: [], totalAssets: 0, scannedDocuments: 0 }), remove, identify: (ref) => ref, readyToDeleteBytes: async () => ({ ready: true }), hashesOf }
}

describe('deleting an Asset through the graph\'s tools', () => {
    it('forgets each file\'s state and tells the workspace it has gone, after the bytes', async () => {
        const order: string[] = []
        const tools = forgettingAssetTools(
            toolsOver(async ([id]) => (order.push(`remove ${id}`), 1), async () => new Map([['pump.pdf', 'h1']])),
            { forgetState: async (hash) => void order.push(`forget ${hash}`), gone: (targets, hash) => void order.push(`gone ${targets} ${hash}`) },
        )
        expect(await tools.remove(['pump.pdf', 'bed.png'])).toBe(2)
        expect(order).toEqual(['remove pump.pdf', 'forget h1', 'gone pump.pdf h1', 'remove bed.png', 'gone bed.png null'])
    })

    it('forgets nothing about a file that was not removed', async () => {
        const forgetState = vi.fn(async () => {})
        const gone = vi.fn()
        const tools = forgettingAssetTools(toolsOver(async () => 0, async () => new Map([['pump.pdf', 'h1']])), { forgetState, gone })
        expect(await tools.remove(['pump.pdf'])).toBe(0)
        expect(forgetState).not.toHaveBeenCalled()
        expect(gone).not.toHaveBeenCalled()
    })

    it('still deletes, and still clears the tab, when the hash or the state cannot be reached', async () => {
        const gone = vi.fn()
        const refusing = forgettingAssetTools(toolsOver(async () => 1, async () => Promise.reject(new Error('offline'))), { forgetState: async () => {}, gone })
        expect(await refusing.remove(['pump.pdf'])).toBe(1)
        const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
        const broken = forgettingAssetTools(toolsOver(async () => 1, async () => new Map([['pump.pdf', 'h1']])), { forgetState: async () => Promise.reject(new Error('closed')), gone })
        expect(await broken.remove(['pump.pdf'])).toBe(1)
        expect(gone).toHaveBeenCalledTimes(2)
        expect(warned).toHaveBeenCalledTimes(1)
        warned.mockRestore()
    })

    it('reads no hash where none is needed', async () => {
        const hashesOf = vi.fn(async () => new Map<string, string>())
        await forgettingAssetTools(toolsOver(async () => 1, hashesOf), { needsHashes: async () => false, forgetState: async () => {}, gone: () => {} }).remove(['x'])
        expect(hashesOf).not.toHaveBeenCalled()
    })

    it('deletes at once where the hash was read before, so an Undo meets a file already gone', async () => {
        const order: string[] = []
        const hashesOf = vi.fn(async () => new Map<string, string>())
        const tools = forgettingAssetTools(toolsOver(async () => (order.push('remove'), 1), hashesOf), { known: (id) => (id === 'a' ? 'h1' : null), forgetState: async (hash) => void order.push(hash), gone: () => {} })
        const removing = tools.remove(['a'])
        // In the same turn: no request came between.
        expect(order).toEqual(['remove'])
        await removing
        await tools.remove(['picture'])
        expect(hashesOf).not.toHaveBeenCalled()
        expect(order).toEqual(['remove', 'h1', 'remove'])
    })

    it('knows the tabs an identity can have: a file\'s own name, or a synced id with the type of file', () => {
        expect(targetsOfAsset('pump.a1b2c3d4.pdf', false)).toEqual(['pump.a1b2c3d4.pdf'])
        // A folder's file with no type is not `Manual.pdf`.
        expect(targetsOfAsset('Manual', false)).toEqual(['Manual'])
        expect(targetsOfAsset('3f2c', true)).toEqual(['3f2c.pdf', '3f2c.epub', '3f2c'])
    })
})

describe('on a Folder graph', () => {
    it('removes the state file of a deleted PDF or EBook, and no other', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        const hash = await hashOf(BYTES)
        for (const name of ['pump.a1b2c3d4.pdf', 'book.a1b2c3d4.epub']) await adapter.writeBinary('assets', name, BYTES)
        await adapter.write('etherpk', `pdf-${hash}.json`, '{}')
        await adapter.write('etherpk', `ebook-${'b'.repeat(64)}.json`, '{}')
        const tools = forgettingAssetTools(filesystemAssetTools(adapter), { forgetState: forgetFolderState(adapter, 'g'), gone: () => {} })
        await tools.remove(['pump.a1b2c3d4.pdf'])
        expect(await adapter.exists('etherpk', `pdf-${hash}.json`)).toBe(false)
        expect(await adapter.exists('etherpk', `ebook-${'b'.repeat(64)}.json`)).toBe(true)
    })

    it('keeps what is kept under the bytes while another file has them, whatever it is named', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        const hash = await hashOf(BYTES)
        const stored = `pump.${hash.slice(0, 8)}.pdf`
        for (const name of ['Manual.pdf', stored]) await adapter.writeBinary('assets', name, BYTES)
        await adapter.write('etherpk', `pdf-${hash}.json`, '{}')
        const gone: (string | null)[] = []
        const tools = forgettingAssetTools(filesystemAssetTools(adapter), { forgetState: forgetFolderState(adapter, 'g'), gone: (_targets, given) => void gone.push(given) })
        await tools.remove(['Manual.pdf'])
        expect(await adapter.exists('etherpk', `pdf-${hash}.json`)).toBe(true)
        expect(gone).toEqual([null])
        await tools.remove([stored])
        expect(await adapter.exists('etherpk', `pdf-${hash}.json`)).toBe(false)
        expect(gone).toEqual([null, hash])
    })

    it('keeps it where nobody can tell whether another file has them', async () => {
        const forgetState = vi.fn(async () => {})
        const tools = forgettingAssetTools({ ...toolsOver(async () => 1, async () => new Map([['a', 'h1']])), copyOf: () => Promise.reject(new Error('offline')) }, { forgetState, gone: () => {} })
        await tools.remove(['a'])
        expect(forgetState).not.toHaveBeenCalled()
    })

    it('takes the bookmarks out of the lists of a graph that is not open, and writes neither where nothing goes', async () => {
        const adapter = createMemoryDirectoryAdapter({ now: () => 1 })
        const hash = await hashOf(BYTES)
        const mark = (id: string, over: object = {}) => ({ id, hash, target: 'pump.pdf', name: 'pump.pdf', page: 2, createdAt: 1, ...over })
        await adapter.writeBinary('assets', 'pump.pdf', BYTES)
        await adapter.write('etherpk', 'pdf-bookmarks.json', JSON.stringify([mark('a'), mark('b', { hash: 'c'.repeat(64), target: 'seeds.pdf' })]))
        await forgettingAssetTools(filesystemAssetTools(adapter), closedFolderForgetting(adapter, 'g')).remove(['pump.pdf'])
        expect((JSON.parse((await adapter.read('etherpk', 'pdf-bookmarks.json')).text) as { id: string }[]).map((b) => b.id)).toEqual(['b'])
        expect(await adapter.exists('etherpk', 'ebook-bookmarks.json')).toBe(false)
    })
})

describe('on a synced graph', () => {
    it('asks only the reader whose index holds the hash, and neither for a file nobody wrote on', async () => {
        const forgot: string[] = []
        const reader = (name: string, held: Record<string, string[]>) => ({
            index: (member: string) => ({ hashes: () => held[member] ?? [] }),
            state: () => ({ forget: async (hash: string) => void forgot.push(`${name} ${hash}`) }),
        })
        const from = { members: [null, 'ann', 'ben'], pdf: reader('pdf', { ben: ['h1'] }), ebook: reader('ebook', { ann: ['h2'] }) }
        await forgetSyncedState('h1', from)
        await forgetSyncedState('h2', from)
        await forgetSyncedState('picture', from)
        expect(forgot).toEqual(['pdf h1', 'ebook h2'])
    })
})
