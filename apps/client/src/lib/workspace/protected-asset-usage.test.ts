import { describe, expect, it, vi } from 'vitest'

import type { ConceptCandidate } from '$lib/document/index-db'
import { DEFAULT_LOCK_SETTINGS } from '$lib/document/protection/lock-machine'
import { ProtectionService } from '$lib/document/protection/protection-service'
import { inMemoryProtectionStore } from '$lib/document/protection/protection-store'
import { protectedTextReader } from '$lib/document/protection/protected-text-reader'
import { createFilesystemDocumentStore } from '$lib/storage/fs/filesystem-store'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import { filesystemStoredTexts, protectedUsageReader, serverStoredTexts } from './protected-asset-usage'

/**
 * The workspace's wiring for the in-document delete's protected-document question: which
 * documents it reads, that it reads stored text without opening anything, and that it settles
 * pending edits first.
 */

async function unlocked() {
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

const candidate = (display: string, kind: ConceptCandidate['kind'], isProtected: boolean): ConceptCandidate => ({
    display,
    key: display.toLowerCase(),
    kind,
    ...(isProtected ? { protected: true as const } : {}),
})

describe('protectedUsageReader over a folder graph', () => {
    async function folderGraph() {
        const service = await unlocked()
        const adapter = createMemoryDirectoryAdapter({ now: () => 0 })
        await adapter.ensureSkeleton()
        await adapter.write('pages', 'Vault.md', await service.protectDocument('---\ntitle: Vault\n---\n- ![scan](../assets/scan.7f3a.png)\n'))
        await adapter.write('pages', 'Plain.md', '- ![scan](../assets/scan.7f3a.png)\n')
        const store = createFilesystemDocumentStore(adapter)
        await store.scan()
        return { service, adapter, store }
    }

    it('reads the documents the index flags as protected, from their files, after settling', async () => {
        const { service, adapter, store } = await folderGraph()
        const open = vi.spyOn(store, 'open')
        const order: string[] = []
        const usage = protectedUsageReader({
            // Plain is counted by the index itself; an alias and a pageless name have no file.
            concepts: () => [candidate('Vault', 'page', true), candidate('Plain', 'page', false), candidate('Safe', 'alias', true), candidate('Ghost', 'pageless', true)],
            readStored: async (concepts) => {
                order.push(`read ${concepts.join()}`)
                return filesystemStoredTexts(store, adapter)(concepts)
            },
            readProtected: protectedTextReader(service),
            settle: async () => {
                order.push('settle')
            },
        })

        expect(await usage(['7f3a'])).toEqual({ readable: true, references: 1, documents: [{ concept: 'Vault', kind: 'page', references: 1 }] })
        expect(order).toEqual(['settle', 'read Vault'])
        expect(open).not.toHaveBeenCalled()

        service.lockNow()
        expect(await usage(['7f3a'])).toEqual({ readable: false, unreadable: 1 })
    })

    it('counts a flagged document whose file cannot be read as unread', async () => {
        const { service, adapter, store } = await folderGraph()
        const failing = { read: async () => Promise.reject(new Error('NotReadableError')) }
        const usage = protectedUsageReader({
            concepts: () => [candidate('Vault', 'page', true)],
            readStored: filesystemStoredTexts(store, failing),
            readProtected: protectedTextReader(service),
            settle: async () => {},
        })
        expect(await usage(['7f3a'])).toEqual({ readable: false, unreadable: 1 })
        expect(await filesystemStoredTexts(store, adapter)(['Nowhere'])).toEqual(new Map([['Nowhere', null]]))
        // Two files answering to one name: which one the index flagged is unknown.
        const twins = { listDocuments: () => [...store.listDocuments(), { ...store.listDocuments().find((e) => e.concept === 'Plain')!, fileName: 'Plain copy.md' }] }
        expect(await filesystemStoredTexts(twins, adapter)(['Plain'])).toEqual(new Map([['Plain', null]]))
    })
})

describe('serverStoredTexts', () => {
    // A concurrent create can leave two registry entries answering to one name; which of the two
    // the index flagged is unknown, and reading the unprotected twin would find no references.
    it('answers null for a name two documents answer to', async () => {
        const read = serverStoredTexts({
            listIdentities: () => [
                { docId: 'd1', kind: 'page', concept: 'Vault', aliases: [] },
                { docId: 'd2', kind: 'page', concept: 'vault', aliases: [] },
            ],
            readTexts: async (docIds) => new Map(docIds.map((id) => [id, { text: id === 'd1' ? 'sealed' : 'plain twin', settled: true }])),
        })
        expect(await read(['Vault'])).toEqual(new Map([['Vault', null]]))
    })

    it('answers null for a text the relay could not confirm current, or a name with no document', async () => {
        const read = serverStoredTexts({
            listIdentities: () => [
                { docId: 'd1', kind: 'page', concept: 'Vault', aliases: [] },
                { docId: 'd2', kind: 'page', concept: 'Behind', aliases: [] },
            ],
            readTexts: async (docIds) =>
                new Map(docIds.map((id) => [id, id === 'd1' ? { text: 'sealed', settled: true } : { text: 'stale', settled: false }])),
        })
        expect(await read(['vault', 'Behind', 'Gone'])).toEqual(
            new Map([
                ['vault', 'sealed'],
                ['Behind', null],
                ['Gone', null],
            ]),
        )
    })
})
