import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { isPlainFolderPath, parsePlainUrl, plainFileUrl, plainFolderUrl, resolvePlainAddress } from './plain-address'
import { type PlainFolderPort, type PlainFolderRecord, createPlainFolderRegistry } from './plain-folder-registry'

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.PLAIN_FUZZ_SEED
    return { numRuns: Number(process.env.PLAIN_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261121 : Number(seed) }
}

describe('the address of a Plain Folder', () => {
    it('names the folder, and a file by its path', () => {
        expect(plainFolderUrl('garden handbook')).toBe('/folder/garden%20handbook')
        expect(plainFileUrl('garden', 'guide/bed layout.md')).toBe('/folder/garden/f/guide/bed%20layout.md')
        expect(parsePlainUrl('/folder/garden%20handbook')).toEqual({ name: 'garden handbook', path: null })
        expect(parsePlainUrl('/folder/garden/f/guide/bed%20layout.md')).toEqual({ name: 'garden', path: 'guide/bed layout.md' })
    })

    it('is not an address under /graph, and refuses a path that leaves the folder', () => {
        expect(parsePlainUrl('/graph/folder/garden')).toBeNull()
        expect(parsePlainUrl('/folder/garden/f/../../secrets')).toBeNull()
        expect(parsePlainUrl('/folder/garden/x/y')).toBeNull()
        expect(parsePlainUrl('/folder/')).toBeNull()
        expect(isPlainFolderPath('/folder/garden/f/a.md')).toBe(true)
        expect(isPlainFolderPath('/folders')).toBe(false)
    })

    it('reads back any folder name and file path it wrote', () => {
        const segment = fc
            .string({ unit: fc.constantFrom('a', 'Z', '9', ' ', '.', '%', '#', '?', '&', '+', '(', 'é', '園'), minLength: 1, maxLength: 6 })
            .filter((s) => s !== '.' && s !== '..')
            .map((s) => s.normalize('NFC'))
        fc.assert(
            fc.property(segment, fc.array(segment, { minLength: 1, maxLength: 4 }), (name, parts) => {
                const path = parts.join('/')
                expect(parsePlainUrl(plainFileUrl(name, path))).toEqual({ name, path })
                expect(parsePlainUrl(plainFolderUrl(name))).toEqual({ name, path: null })
            }),
            fuzz(1000),
        )
    })

    it('finds the folder an address names, and asks when two share the name', () => {
        const record = (id: string, name: string): PlainFolderRecord => ({ id, name, createdAt: 1, handle: {} })
        const folders = [record('a', 'garden'), record('b', 'notes'), record('c', 'notes')]
        expect(resolvePlainAddress('garden', folders)).toEqual({ kind: 'held', folder: folders[0] })
        expect(resolvePlainAddress('notes', folders)).toEqual({ kind: 'choice', folders: [folders[1], folders[2]] })
        expect(resolvePlainAddress('Garden', folders)).toEqual({ kind: 'not-held' })
    })
})

describe('the Plain Folder registry', () => {
    function memoryPort(): PlainFolderPort {
        const records = new Map<string, PlainFolderRecord>()
        return {
            getAll: async () => [...records.values()],
            put: async (record) => void records.set(record.id, record),
            delete: async (id) => void records.delete(id),
        }
    }

    it('lists folders oldest first, keeps the first record of an id, and forgets on request', async () => {
        const registry = createPlainFolderRegistry(memoryPort())
        await registry.add({ id: 'b', name: 'notes', createdAt: 20, handle: { fake: 'b' } })
        await registry.add({ id: 'a', name: 'garden', createdAt: 10, handle: { fake: 'a' } })
        const kept = await registry.add({ id: 'a', name: 'renamed', createdAt: 99, handle: { fake: 'other' } })
        expect(kept.name).toBe('garden')
        expect((await registry.list()).map((folder) => folder.id)).toEqual(['a', 'b'])
        expect(await registry.get('b')).toMatchObject({ name: 'notes' })
        await registry.remove('a')
        expect((await registry.list()).map((folder) => folder.id)).toEqual(['b'])
        expect(await registry.get('a')).toBeUndefined()
    })
})
