import 'fake-indexeddb/auto'

import { connectNativeBridge, NATIVE_PORT_NAME } from '@appsoftwareltd/etherpk-native-bridge'
import { createMemoryNative, type MemoryNative } from '@appsoftwareltd/etherpk-native-bridge/memory'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let native: MemoryNative

// The shell is read once, when bridge.ts is first imported, so each test imports the modules afresh.
beforeEach(() => {
    vi.resetModules()
    native = createMemoryNative()
    vi.stubGlobal('window', { [NATIVE_PORT_NAME]: native.port })
})
afterEach(() => vi.unstubAllGlobals())

const folderRef = () => import('./folder-ref')
const refTo = async (path: string) => (await folderRef()).nativeFolderRef(native.grantFolder(path))

describe('a folder a shell gave', () => {
    it('is known by what it is, with no permission to ask for', async () => {
        const { isNativeFolder } = await folderRef()
        const folder = await refTo('Documents/Garden')
        expect([folder.kind, folder.name]).toEqual(['directory', 'Garden'])
        expect(isNativeFolder(folder)).toBe(true)
        expect(isNativeFolder({ kind: 'directory', name: 'Garden', nativeId: 'x' })).toBe(false)
        const { ensurePermission, hasPermission } = await import('../storage/graph-registry-idb')
        expect([await ensurePermission(folder), await hasPermission(folder)]).toEqual([true, true])
    })

    it('is compared by the shell, since two ids can be one folder', async () => {
        const [garden, again, pages] = [await refTo('Documents/Garden'), await refTo('Documents/Garden'), await refTo('Documents/Garden/pages')]
        expect(garden.nativeId).not.toBe(again.nativeId)
        expect(await garden.isSameEntry(again)).toBe(true)
        expect(await garden.isSameEntry(pages)).toBe(false)
        expect(await garden.resolve(pages)).toEqual(['pages'])
        expect(await pages.resolve(garden)).toBe(null)
        expect(await garden.resolve(garden)).toEqual([])
    })

    it('is never a browser’s handle', async () => {
        const garden = await refTo('Documents/Garden')
        const handle = { kind: 'directory', name: 'Garden', isSameEntry: async () => true }
        expect(await garden.isSameEntry(handle)).toBe(false)
        expect(await garden.resolve(handle)).toBe(null)
        for (const other of [null, undefined, 'Garden', {}]) expect(await garden.isSameEntry(other)).toBe(false)
    })

    it('is found to be a graph’s folder, one inside it, or one that holds it', async () => {
        const { findFolderOwner } = await import('../storage/synced/mirror-takeover')
        const garden = await refTo('Documents/Garden')
        const known = [{ handle: garden, owner: { kind: 'folder-graph' as const, graphId: 'g', name: 'Garden' } }]
        expect(await findFolderOwner(await refTo('Documents/Garden'), known)).toMatchObject({ relation: 'same' })
        expect(await findFolderOwner(await refTo('Documents/Garden/assets/plans'), known)).toMatchObject({ relation: 'inside' })
        native.disk.makeDirectory('Documents/Vault/pages')
        const pages = await refTo('Documents/Vault/pages')
        expect(await findFolderOwner(await refTo('Documents/Vault'), [{ ...known[0], handle: pages }])).toMatchObject({ relation: 'holds', subfolder: 'pages' })
        expect(await findFolderOwner(await refTo('Documents/Elsewhere'), known)).toBe(null)
    })

    it('says when it is gone, and where it is', async () => {
        const { nativeFolderIsThere, nativeFolderPath } = await folderRef()
        const { isFolderLost } = await import('../storage/folder-access')
        const garden = await refTo('Documents/Garden')
        expect(await nativeFolderPath(garden)).toBe('/Documents/Garden')
        expect([await nativeFolderIsThere(garden), await isFolderLost(garden)]).toEqual([true, false])
        native.disk.remove('Documents/Garden')
        expect([await nativeFolderIsThere(garden), await isFolderLost(garden)]).toEqual([false, true])
        expect(await nativeFolderPath(garden)).toBe(null)
        expect(await isFolderLost({ kind: 'directory', name: 'a browser’s handle' })).toBe(false)
        expect(await isFolderLost(undefined)).toBe(false)
    })
})

describe('a folder a shell gave, kept in IndexedDB', () => {
    /** What a fresh start of the app reads back. */
    async function restarted() {
        vi.resetModules()
        return folderRef()
    }

    it('survives a structured clone as its id, and other handles are kept as they are', async () => {
        const { fromStoredFolder, isNativeFolder, toStoredFolder } = await folderRef()
        const garden = await refTo('Documents/Garden')
        const stored = structuredClone(toStoredFolder(garden))
        expect(stored).toEqual({ nativeFolder: garden.nativeId, name: 'Garden' })
        const back = fromStoredFolder(stored)
        expect(isNativeFolder(back) && (await back.isSameEntry(garden))).toBe(true)
        for (const other of [null, undefined, { opfsPath: ['a'] }, { rootDocId: 'x' }, 'x']) {
            expect(toStoredFolder(other)).toBe(other)
            expect(fromStoredFolder(other)).toBe(other)
        }
    })

    it('is read back by the graph registry, and by Plain Folders', async () => {
        const garden = await refTo('Documents/Garden')
        const { createIdbGraphRegistry } = await import('../storage/graph-registry-idb')
        await createIdbGraphRegistry().insertGraph({ id: 'g', name: 'Garden', backend: 'filesystem', where: 'folder', createdAt: 1, handle: garden })
        const { createIdbPlainFolderRegistry } = await import('../plain/plain-folder-registry-idb')
        await createIdbPlainFolderRegistry().add({ id: 'p', name: 'Garden', createdAt: 1, handle: garden })

        const { isNativeFolder } = await restarted()
        const graph = await (await import('../storage/graph-registry-idb')).createIdbGraphRegistry().getGraph('g')
        const plain = await (await import('../plain/plain-folder-registry-idb')).createIdbPlainFolderRegistry().get('p')
        for (const handle of [graph?.handle, plain?.handle]) expect(isNativeFolder(handle) && [handle.name, handle.nativeId]).toEqual(['Garden', garden.nativeId])
    })

    it('stays listed when its folder is gone, for the person to choose it again', async () => {
        const garden = await refTo('Documents/Garden')
        const { createIdbGraphRegistry } = await import('../storage/graph-registry-idb')
        await createIdbGraphRegistry().insertGraph({ id: 'lost', name: 'Garden', backend: 'filesystem', where: 'folder', createdAt: 1, handle: garden })
        native.disk.remove('Documents/Garden')
        await restarted()
        expect((await (await import('../storage/graph-registry-idb')).createIdbGraphRegistry().listGraphs()).map((graph) => graph.id)).toContain('lost')
    })

    it('is read back as a mirror’s folder and as a publication’s', async () => {
        const copy = await refTo('Backups/Copy')
        const mirrors = await import('../storage/mirror-folder-idb')
        await mirrors.writeMirrorFolder({ graphId: 'g', handle: copy, folder: 'Copy' })
        const publications = await import('../storage/publication-destination-idb')
        const key = publications.publicationDestinationKey('g', 'docs')
        await publications.writePublicationDestination({ key, graphId: 'g', publicationId: 'docs', handle: copy, folder: 'Copy' })
        await publications.writePublicationDestination({ key: 'g/blog', graphId: 'g', publicationId: 'blog', repository: { owner: 'o', name: 'n', branch: 'main' } })

        const { isNativeFolder } = await restarted()
        const mirror = await import('../storage/mirror-folder-idb')
        const publication = await import('../storage/publication-destination-idb')
        const found = await publication.readPublicationDestination('g', 'docs')
        for (const handle of [(await mirror.readMirrorFolder('g'))?.handle, (await mirror.listMirrorFolders())[0].handle, found && 'handle' in found ? found.handle : null]) {
            expect(isNativeFolder(handle) && handle.nativeId).toBe(copy.nativeId)
        }
        expect(await publication.readPublicationDestination('g', 'blog')).toMatchObject({ repository: { owner: 'o' } })
        expect(await mirror.readMirrorFolder('none')).toBeUndefined()
        expect(await publication.readPublicationDestination('g', 'none')).toBeUndefined()
    })
})

describe('a folder the app no longer keeps', () => {
    it('is given back to the shell once no record holds it', async () => {
        const { releaseFolder } = await import('../storage/release-folder')
        const { createIdbPlainFolderRegistry } = await import('../plain/plain-folder-registry-idb')
        const { writeMirrorFolder, forgetMirrorFolder } = await import('../storage/mirror-folder-idb')
        const garden = await refTo('Documents/Garden')
        const held = async () => (await native.port.call('folders.get', { folder: garden.nativeId })).ok && (await (await folderRef()).nativeFolderIsThere(garden))
        const registry = createIdbPlainFolderRegistry()
        await registry.add({ id: 'kept', name: 'Garden', createdAt: 1, handle: garden })
        await writeMirrorFolder({ graphId: 'kept', handle: garden, folder: 'Garden' })
        await registry.remove('kept')
        await releaseFolder(garden)
        expect(await held()).toBe(true)
        await forgetMirrorFolder('kept')
        await releaseFolder(garden)
        expect(await held()).toBe(false)
        // Nothing to give back, and nothing that fails.
        await releaseFolder({ kind: 'directory' })
        await releaseFolder(undefined)
    })
})

describe('choosing a folder', () => {
    it('asks the shell first, whatever the page’s own engine has', async () => {
        ;(window as unknown as Record<string, unknown>).showDirectoryPicker = () => Promise.reject(new DOMException('cancelled', 'AbortError'))
        const { canPickFolder, pickFolder, directoryAdapterFor, treeAdapterFor, isFolderOnDisk } = await import('../storage/folder-access')
        expect(canPickFolder()).toBe(true)
        native.disk.write('Documents/Garden/pages/A.md', 'one')
        native.answerFolder('Documents/Garden')
        const folder = await pickFolder()
        expect(folder.name).toBe('Garden')
        expect((await directoryAdapterFor(folder).read('pages', 'A.md')).text).toBe('one')
        expect(await treeAdapterFor(folder).list('')).toEqual([{ name: 'pages', kind: 'directory' }])
        expect(await isFolderOnDisk(folder)).toBe(true)
        native.answerFolder(null)
        await expect(pickFolder()).rejects.toMatchObject({ name: 'AbortError' })
    })

    it('is the browser’s picker where there is no shell', async () => {
        const handle = { kind: 'directory', name: 'Garden' }
        vi.stubGlobal('window', { showDirectoryPicker: async () => handle })
        const { canPickFolder, pickFolder } = await import('../storage/folder-access')
        expect(canPickFolder()).toBe(true)
        expect(await pickFolder()).toBe(handle)
        vi.stubGlobal('window', {})
        expect(canPickFolder()).toBe(false)
    })
})

describe('a file a shell gave, found in a folder', () => {
    async function find(opened: string, chosen: string) {
        const { nativeFileRef } = await import('./file-ref')
        const { pathInFolder } = await import('../plain/launched-file')
        return pathInFolder(await refTo(chosen), nativeFileRef(native.grantFile(opened)))
    }

    it('is the one of its name that holds its bytes', async () => {
        native.disk.write('Handbook/guide/notes.md', 'first')
        native.disk.write('Handbook/other/notes.md', 'second')
        expect(await find('Handbook/other/notes.md', 'Handbook')).toBe('other/notes.md')
        native.disk.write('Elsewhere/notes.md', 'third')
        expect(await find('Elsewhere/notes.md', 'Handbook')).toBe(null)
    })

    it('is told from a copy of it by where it is', async () => {
        native.disk.write('Handbook/a/notes.md', 'the same')
        native.disk.write('Handbook/b/notes.md', 'the same')
        expect(await find('Handbook/b/notes.md', 'Handbook')).toBe('b/notes.md')
    })

    it('is searched for in runs, and a folder too large to search says so', async () => {
        const { FolderTooLargeToSearch } = await import('../plain/launched-file')
        for (let at = 0; at < 120; at++) native.disk.write(`Handbook/d${at}/notes.md`, `copy ${at}`)
        expect(await find('Handbook/d117/notes.md', 'Handbook')).toBe('d117/notes.md')
        const runs = native.calls.filter((call) => call.method === 'fs.readMany').map((call) => (call.args as { paths: string[] }).paths.length)
        expect(Math.max(...runs)).toBeLessThanOrEqual(50)
        // A walk that stopped at its limit may have passed the file by.
        native.hook({ before: ({ method }) => (method === 'fs.walk' ? { ok: true, value: { files: [], truncated: true } } : undefined) })
        await expect(find('Handbook/d1/notes.md', 'Handbook')).rejects.toBeInstanceOf(FolderTooLargeToSearch)
    })

    it('is nowhere in a browser’s folder', async () => {
        const { nativeFileRef } = await import('./file-ref')
        const { pathInFolder } = await import('../plain/launched-file')
        native.disk.write('notes.md', 'x')
        expect(await pathInFolder({ kind: 'directory', name: 'x' } as unknown as FileSystemDirectoryHandle, nativeFileRef(native.grantFile('notes.md')))).toBe(null)
    })
})

describe('a folder’s watch', () => {
    it('reports changes to its own folder only, until it is stopped', async () => {
        const { folderWatch } = await import('./folder-watch')
        const bridge = connectNativeBridge(native.port)
        const garden = await refTo('Documents/Garden')
        const other = await refTo('Documents/Other')
        const heard: (readonly string[] | null)[] = []
        const stop = folderWatch(garden, bridge)!((paths) => heard.push(paths), () => heard.push(['lost']))
        const otherStop = folderWatch(other, bridge)!(() => {}, () => {})
        await vi.waitFor(() => expect(heard).toEqual([null])) // what may have changed before it began
        native.disk.write('Documents/Garden/pages/A.md', 'one')
        native.disk.write('Documents/Other/B.md', 'two')
        await vi.waitFor(() => expect(heard.at(-1)).toContain('pages/A.md'))
        expect(heard.flat()).not.toContain('B.md')
        stop()
        otherStop()
        await vi.waitFor(() => expect(native.calls.filter((call) => call.method === 'fs.unwatch')).toHaveLength(2))
        native.emit('fsChanged', { folder: garden.nativeId, paths: ['after.md'] })
        expect(heard.flat()).not.toContain('after.md')
    })

    it('says once that it is lost, at the start or later', async () => {
        const { folderWatch } = await import('./folder-watch')
        const bridge = connectNativeBridge(native.port)
        const garden = await refTo('Documents/Garden')
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        native.fail('fs.watch', 'NotSupportedError')
        const refused = vi.fn()
        folderWatch(garden, bridge)!(() => {}, refused)
        await vi.waitFor(() => expect(refused).toHaveBeenCalledTimes(1))

        const lost = vi.fn()
        const stop = folderWatch(garden, bridge)!(() => {}, lost)
        await vi.waitFor(() => expect(native.calls.filter((call) => call.method === 'fs.watch')).toHaveLength(2))
        native.loseWatch(garden.nativeId)
        native.loseWatch(garden.nativeId)
        expect(lost).toHaveBeenCalledTimes(1)
        stop()
        warn.mockRestore()
    })

    it('stopped before it began is ended when it does', async () => {
        const { folderWatch } = await import('./folder-watch')
        const bridge = connectNativeBridge(native.port)
        const changed = vi.fn()
        folderWatch(await refTo('Documents/Garden'), bridge)!(changed, () => {})()
        await vi.waitFor(() => expect(native.calls.map((call) => call.method)).toContain('fs.unwatch'))
        expect(changed).not.toHaveBeenCalled()
    })

    it('is nothing for a browser’s handle, in a browser, or where the shell cannot', async () => {
        const { folderWatch } = await import('./folder-watch')
        const garden = await refTo('Documents/Garden')
        expect(folderWatch({ kind: 'directory' }, connectNativeBridge(native.port))).toBe(null)
        expect(folderWatch(garden, null)).toBe(null)
        expect(folderWatch(garden, connectNativeBridge(createMemoryNative({ features: { watch: false } }).port))).toBe(null)
    })
})
