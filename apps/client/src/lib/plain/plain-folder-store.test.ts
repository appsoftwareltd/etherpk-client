import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DocumentNotFoundError } from '../document/types'

import type { FolderTreeAdapter } from './folder-tree-adapter'
import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { type PlainConflict, createPlainFolderStore } from './plain-folder-store'

function clock(start = 1000) {
    let t = start
    return () => (t += 1000)
}
const utf8 = (text: string) => new TextEncoder().encode(text)
const BOM = [0xef, 0xbb, 0xbf]

/** A folder with the store over it, and what the store reported. */
async function folder(seed: Record<string, string | Uint8Array>, wrap: (tree: FolderTreeAdapter) => FolderTreeAdapter = (tree) => tree, editLimitBytes?: number) {
    const tree = createMemoryTreeAdapter({ now: clock(), seed })
    const writes: string[] = []
    const counted: FolderTreeAdapter = {
        ...tree,
        write: async (path, bytes) => {
            writes.push(path)
            return tree.write(path, bytes)
        },
    }
    const conflicts: PlainConflict[] = []
    const errors: unknown[] = []
    const store = createPlainFolderStore(wrap(counted), { autosaveMs: 400, editLimitBytes, onConflict: (c) => conflicts.push(c), onSaveError: (_path, error) => errors.push(error) })
    const bytesOf = async (path: string) => [...(await tree.read(path)).bytes]
    const textOf = async (path: string) => new TextDecoder().decode((await tree.read(path)).bytes)
    const openReady = async (path: string) => {
        const doc = store.open(path)
        await store.whenReady(path)
        return doc
    }
    return { tree, store, writes, conflicts, errors, bytesOf, textOf, openReady }
}

describe('PlainFolderStore: opening and saving a file', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('names the files whose edits are not in the folder: before a save, and after one that failed', async () => {
        let refuse = true
        const { store, openReady, textOf } = await folder({ 'beans.md': 'a', 'peas.md': 'b' }, (tree) => ({
            ...tree,
            write: (path, bytes, options) => (refuse && path === 'beans.md' ? Promise.reject(new DOMException('x', 'NotAllowedError')) : tree.write(path, bytes, options)),
        }))
        for (const path of ['beans.md', 'peas.md']) (await openReady(path)).applyChange({ from: 0, to: 0, insert: 'edited ' })
        expect(store.unsavedPaths()).toEqual(['beans.md', 'peas.md'])
        await store.flushAll()
        expect(store.unsavedPaths()).toEqual(['beans.md'])
        refuse = false
        await store.flushAll()
        expect(store.unsavedPaths()).toEqual([])
        expect(await textOf('beans.md')).toContain('edited')
    })

    it('opens a file by its path and gives the editor line feeds', async () => {
        const { store, openReady } = await folder({ 'guide/watering.md': 'beans\r\npeas\r\n' })
        const doc = store.open('guide/watering.md')
        const seen: string[] = []
        doc.subscribe((text) => seen.push(text))
        expect(doc.getText()).toBe('')
        await store.whenReady('guide/watering.md')
        expect(doc.getText()).toBe('beans\npeas\n')
        expect(seen).toEqual(['beans\npeas\n'])
        expect(await openReady('guide/./watering.md')).toBe(doc) // one file, one buffer
        expect(() => store.open('../outside.md')).toThrow(DocumentNotFoundError)
    })

    it('saves an edit into the file, leaving every other line and its ending as it was', async () => {
        const { store, openReady, bytesOf } = await folder({ 'notes.md': new Uint8Array([...BOM, ...utf8('beans\r\npeas\r\nroots\r\n')]) })
        const doc = await openReady('notes.md')
        doc.applyChange({ from: 6, to: 6, insert: 'sweet ' })
        await vi.advanceTimersByTimeAsync(400)
        expect(await bytesOf('notes.md')).toEqual([...BOM, ...utf8('beans\r\nsweet peas\r\nroots\r\n')])
        expect(store.stateOf('notes.md')).toMatchObject({ dirty: false, loaded: true })
    })

    it('writes nothing when the text ends as it began', async () => {
        const { store, openReady, writes } = await folder({ 'notes.md': 'beans\r\n' })
        const doc = await openReady('notes.md')
        doc.applyChange({ from: 0, to: 0, insert: 'x' })
        doc.applyChange({ from: 0, to: 1, insert: '' })
        await store.flushDocument('notes.md')
        expect(writes).toEqual([])
        expect(store.stateOf('notes.md')?.dirty).toBe(false)
    })

    it('opening and closing a folder’s files writes nothing at all', async () => {
        const { store, openReady, writes } = await folder({ 'README.md': '# Garden', 'guide/watering.md': 'water' })
        await openReady('README.md')
        await openReady('guide/watering.md')
        await store.reconcile()
        await store.dispose()
        expect(writes).toEqual([])
    })

    it('never rejects a failed save: the buffer is kept and a flush tries again', async () => {
        const failing = { now: true }
        const { store, openReady, errors, textOf } = await folder({ 'notes.md': 'beans' }, (tree) => ({
            ...tree,
            write: async (path, bytes) => {
                if (failing.now) throw new DOMException('The disk is full.', 'QuotaExceededError')
                return tree.write(path, bytes)
            },
        }))
        const doc = await openReady('notes.md')
        doc.applyChange({ from: 5, to: 5, insert: ' and peas' })
        await vi.advanceTimersByTimeAsync(400)
        expect(errors).toHaveLength(1)
        expect(store.stateOf('notes.md')).toMatchObject({ dirty: true })
        failing.now = false
        await store.flushDocument('notes.md')
        expect(await textOf('notes.md')).toBe('beans and peas')
        expect(store.stateOf('notes.md')).toMatchObject({ dirty: false, error: null })
    })
})

describe('PlainFolderStore: another program writes the folder', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('a save stops at a conflict when the file changed since it was read', async () => {
        const { tree, openReady, conflicts, textOf, writes } = await folder({ 'notes.md': 'base' })
        const doc = await openReady('notes.md')
        doc.applyChange({ from: 4, to: 4, insert: ' mine' })
        await tree.write('notes.md', utf8('base theirs'))
        await vi.advanceTimersByTimeAsync(400)
        expect(conflicts).toEqual([{ path: 'notes.md', diskText: 'base theirs', bufferText: 'base mine' }])
        expect(await textOf('notes.md')).toBe('base theirs')
        expect(writes).toEqual([])
    })

    it('settles a conflict either way, and asks again if the file moved while choosing', async () => {
        const { tree, store, openReady, conflicts, textOf } = await folder({ 'notes.md': 'base\r\nend\r\n' })
        const doc = await openReady('notes.md')
        doc.applyChange({ from: 4, to: 4, insert: ' mine' })
        await tree.write('notes.md', utf8('base theirs\r\nend\r\n'))
        await store.flushDocument('notes.md')
        await tree.write('notes.md', utf8('base theirs again\r\nend\r\n'))
        await expect(store.resolveConflict('notes.md', 'keep-mine')).rejects.toThrow(/changed the file again/)
        expect(conflicts.map((c) => c.diskText)).toEqual(['base theirs\nend\n', 'base theirs again\nend\n'])
        await store.resolveConflict('notes.md', 'keep-mine')
        expect(await textOf('notes.md')).toBe('base mine\r\nend\r\n') // the file's own endings, kept

        doc.applyChange({ from: 0, to: 0, insert: 'x' })
        await tree.write('notes.md', utf8('theirs\r\n'))
        await store.flushDocument('notes.md')
        await store.resolveConflict('notes.md', 'take-disk')
        expect(doc.getText()).toBe('theirs\n')
        expect(store.stateOf('notes.md')).toMatchObject({ dirty: false, conflict: null })
    })

    it('a rescan reloads a file with no unsaved edits and raises a conflict over one with', async () => {
        const { tree, store, openReady, conflicts } = await folder({ 'a.md': 'one', 'b.md': 'two' })
        const a = await openReady('a.md')
        const b = await openReady('b.md')
        b.applyChange({ from: 3, to: 3, insert: '!' })
        await tree.write('a.md', utf8('one changed'))
        await tree.write('b.md', utf8('two changed'))
        await store.reconcile()
        expect(a.getText()).toBe('one changed')
        expect(conflicts.map((c) => c.path)).toEqual(['b.md'])
        expect(b.getText()).toBe('two!')
    })

    it('counts a file that already holds the buffer as saved', async () => {
        const { tree, store, openReady, conflicts, writes } = await folder({ 'notes.md': 'base' })
        const doc = await openReady('notes.md')
        doc.applyChange({ from: 4, to: 4, insert: ' same' })
        await tree.write('notes.md', utf8('base same'))
        await store.flushDocument('notes.md')
        expect(conflicts).toEqual([])
        expect(writes).toEqual([])
        expect(store.stateOf('notes.md')?.dirty).toBe(false)
    })

    it('never writes back a file that was removed elsewhere, until the person restores it', async () => {
        const { tree, store, openReady, writes, textOf } = await folder({ 'guide/watering.md': 'water' })
        const doc = await openReady('guide/watering.md')
        await tree.remove('guide') // a checkout took the whole directory
        doc.applyChange({ from: 5, to: 5, insert: ' daily' })
        await vi.advanceTimersByTimeAsync(400)
        expect(writes).toEqual([])
        expect(await tree.stat('guide/watering.md')).toBeNull()
        expect(store.stateOf('guide/watering.md')).toMatchObject({ removedElsewhere: true, dirty: true })

        await store.restore('guide/watering.md')
        expect(await textOf('guide/watering.md')).toBe('water daily')
        expect(store.stateOf('guide/watering.md')).toMatchObject({ removedElsewhere: false, dirty: false })
    })

    it('a rescan notes a removal, and takes the file up again when it comes back', async () => {
        const { tree, store, openReady } = await folder({ 'notes.md': 'water' })
        const doc = await openReady('notes.md')
        await tree.remove('notes.md')
        await store.reconcile()
        expect(store.stateOf('notes.md')?.removedElsewhere).toBe(true)
        await tree.write('notes.md', utf8('water again'))
        await store.reconcile()
        expect(store.stateOf('notes.md')?.removedElsewhere).toBe(false)
        expect(doc.getText()).toBe('water again')
    })

    it('reports a file it cannot read as a failed save, and writes nothing over it', async () => {
        const denied = { now: false }
        const { store, openReady, errors, writes } = await folder({ 'notes.md': 'base' }, (tree) => ({
            ...tree,
            read: async (path) => {
                if (denied.now) throw new DOMException('Permission to the folder has lapsed.', 'NotAllowedError')
                return tree.read(path)
            },
        }))
        const doc = await openReady('notes.md')
        doc.applyChange({ from: 4, to: 4, insert: ' mine' })
        denied.now = true
        await store.flushDocument('notes.md')
        expect((errors[0] as Error).name).toBe('NotAllowedError')
        expect(writes).toEqual([])
    })
})

describe('PlainFolderStore: files it will not edit as they stand', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('opens a file that is not UTF-8 read-only and never writes it', async () => {
        const latin1 = new Uint8Array([...utf8('caf'), 0xe9, ...utf8(' menu\n')])
        const { store, openReady, writes, bytesOf } = await folder({ 'menu.txt': latin1 })
        const doc = await openReady('menu.txt')
        expect(store.stateOf('menu.txt')).toMatchObject({ readOnly: 'not-utf8', loaded: true })
        doc.applyChange({ from: 0, to: 0, insert: 'x' })
        await store.flushDocument('menu.txt')
        expect(doc.getText()).toBe('caf� menu\n')
        expect(writes).toEqual([])
        expect(await bytesOf('menu.txt')).toEqual([...latin1])
    })

    it('opens a file over the limit read-only, and edits it once the person says so', async () => {
        const { store, openReady, textOf } = await folder({ 'big.md': 'a line of text\n' }, undefined, 8)
        const doc = await openReady('big.md')
        expect(store.stateOf('big.md')).toMatchObject({ readOnly: 'too-large', size: 15 })
        expect(doc.getText()).toBe('')
        store.editAnyway('big.md')
        await store.whenReady('big.md')
        expect(doc.getText()).toBe('a line of text\n')
        doc.applyChange({ from: 0, to: 1, insert: 'A' })
        await store.flushDocument('big.md')
        expect(await textOf('big.md')).toBe('A line of text\n')
    })

    it('says a path with nothing at it is missing, writes nothing, and creates the file on request', async () => {
        const { store, openReady, writes, textOf } = await folder({ 'README.md': 'x' })
        const doc = await openReady('guide/new.md')
        expect(store.stateOf('guide/new.md')).toMatchObject({ missing: true, loaded: false })
        doc.applyChange({ from: 0, to: 0, insert: '# New' })
        await vi.advanceTimersByTimeAsync(400)
        expect(writes).toEqual([])
        await store.restore('guide/new.md')
        expect(await textOf('guide/new.md')).toBe('# New')
        expect(store.stateOf('guide/new.md')).toMatchObject({ missing: false, loaded: true, dirty: false })
    })
})

describe('PlainFolderStore: the tree moves and removes files', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('an open file follows a move of itself or of a directory above it', async () => {
        const { tree, store, openReady, textOf } = await folder({ 'guide/watering.md': 'water' })
        const doc = await openReady('guide/watering.md')
        const renames: string[] = []
        store.onDocumentRenamed((from, to) => renames.push(`${from} -> ${to}`))
        doc.applyChange({ from: 5, to: 5, insert: ' daily' })

        await store.settleUnder('guide') // the unsaved edit lands before the move
        await tree.move('guide', 'handbook')
        store.moved('guide', 'handbook')

        expect(renames).toEqual(['guide/watering.md -> handbook/watering.md'])
        expect(doc.id).toBe('handbook/watering.md')
        expect(store.open('handbook/watering.md')).toBe(doc)
        doc.applyChange({ from: 0, to: 0, insert: 'So: ' })
        await store.flushDocument('handbook/watering.md')
        expect(await textOf('handbook/watering.md')).toBe('So: water daily')
        expect(await tree.stat('guide/watering.md')).toBeNull()
    })

    it('a file the person removed is dropped, and a late save does not bring it back', async () => {
        const { tree, store, openReady, writes } = await folder({ 'notes.md': 'water' })
        const doc = await openReady('notes.md')
        doc.applyChange({ from: 5, to: 5, insert: '!' })
        await tree.remove('notes.md')
        store.removed('notes.md')
        await vi.advanceTimersByTimeAsync(400)
        expect(writes).toEqual([])
        expect(store.stateOf('notes.md')).toBeNull()
    })
})
