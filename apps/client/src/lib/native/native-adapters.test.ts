/**
 * The adapters of an installed app against the in-memory shell. What each seam promises is written
 * where the seam is (directory-adapter.ts, folder-tree-adapter.ts, site-writer.ts).
 */
import { connectNativeBridge } from '@appsoftwareltd/etherpk-native-bridge'
import { createMemoryNative, type MemoryNativeOptions } from '@appsoftwareltd/etherpk-native-bridge/memory'
import { describe, expect, it } from 'vitest'

import { writeSite } from '../document/publish/host/site-writer'
import { walkTree } from '../import/directory-handle-source'
import { createFolderIndex } from '../plain/folder-index'
import { createSingleFileAdapter } from '../plain/single-file-adapter'
import { scanGraph } from '../storage/fs/scan'
import { nativeFileRef } from './file-ref'
import { isNativeFolder, NativeFolderRef } from './folder-ref'
import { createNativeDirectoryAdapter } from './native-directory-adapter'
import { nativeSingleFile } from './native-file-adapter'
import { nativeSiteFolder } from './native-site-folder'
import { createNativeTreeAdapter } from './native-tree-adapter'

function world(options: MemoryNativeOptions = {}) {
    let now = 1_800_000_000_000
    const native = createMemoryNative({ now: () => (now += 1000), ...options })
    const bridge = connectNativeBridge(native.port)
    const { id, name } = native.grantFolder('Garden')
    const folder = new NativeFolderRef(name, id)
    return { native, disk: native.disk, bridge: () => bridge, folder }
}

const nameOfRefusal = async (work: Promise<unknown>) => work.then(() => 'nothing', (error: { name: string }) => error.name)

describe('the adapter of a graph’s folder', () => {
    const make = (options?: MemoryNativeOptions) => {
        const all = world(options)
        return { ...all, fs: createNativeDirectoryAdapter(all.folder, all.bridge) }
    }

    it('makes the skeleton, and a directory that has gone missing on the first listing', async () => {
        const { fs, disk } = make()
        await fs.ensureSkeleton()
        for (const subdir of ['journals', 'pages', 'assets', 'etherpk']) expect(disk.at(`Garden/${subdir}`)?.kind).toBe('directory')
        disk.remove('Garden/journals')
        expect(await fs.list('journals')).toEqual([])
        expect(disk.at('Garden/journals')?.kind).toBe('directory')
    })

    it('lists files with their stamps in one call, and not directories', async () => {
        const { fs, disk, native } = make()
        disk.write('Garden/pages/A.md', 'héllo')
        disk.makeDirectory('Garden/pages/not a page')
        native.calls.length = 0
        const listed = await fs.list('pages')
        expect(listed).toEqual([{ name: 'A.md', lastModified: expect.any(Number), size: 6 }])
        expect(native.calls.map((call) => call.method)).toEqual(['fs.list'])
    })

    it('reads, writes, checks for and removes a file, as text and as bytes', async () => {
        const { fs, disk } = make()
        const written = await fs.write('pages', 'A.md', 'one')
        expect(written).toEqual({ text: 'one', lastModified: expect.any(Number), size: 3 })
        expect(await fs.read('pages', 'A.md')).toEqual(written)
        const bytes = new Uint8Array([0, 255, 10])
        await fs.writeBinary('assets', 'x.png', bytes)
        expect([...(await fs.readBinary('assets', 'x.png')).bytes]).toEqual([0, 255, 10])
        expect([await fs.exists('pages', 'A.md'), await fs.exists('pages', 'B.md')]).toEqual([true, false])
        await fs.remove('pages', 'A.md')
        await fs.remove('pages', 'A.md')
        expect(disk.files('Garden/pages')).toEqual([])
        expect(await nameOfRefusal(fs.read('pages', 'A.md'))).toBe('NotFoundError')
    })

    it('reads a file with a byte order mark without it, as the browser does', async () => {
        const { fs, disk } = make()
        disk.write('Garden/pages/A.md', '﻿one')
        expect((await fs.read('pages', 'A.md')).text).toBe('one')
    })

    it('reaches a file beside the directories, and answers null only for one that is not there', async () => {
        const { fs, native, folder } = make()
        expect(await fs.readRootFile('AGENTS.md')).toBe(null)
        await fs.writeRootFile('AGENTS.md', 'read me')
        expect((await fs.readRootFile('AGENTS.md'))?.text).toBe('read me')
        native.withdraw(folder.nativeId)
        expect(await nameOfRefusal(fs.readRootFile('AGENTS.md'))).toBe('NotAllowedError')
    })

    it('takes one name, never a path', async () => {
        const { fs } = make()
        for (const name of ['../x.md', 'a/b.md', 'a\\b.md', '', '.', '..']) {
            expect([name, await nameOfRefusal(fs.write('pages', name, 'x'))]).toEqual([name, 'TypeError'])
            expect([name, await nameOfRefusal(fs.readRootFile(name))]).toEqual([name, 'TypeError'])
        }
    })

    it('says that a folder has gone, and never lists it as empty or makes it again', async () => {
        const { fs, disk } = make()
        await fs.write('pages', 'A.md', 'one')
        disk.remove('Garden')
        expect(await nameOfRefusal(fs.list('pages'))).toBe('NotFoundError')
        expect(await nameOfRefusal(fs.write('pages', 'A.md', 'two'))).toBe('NotFoundError')
        expect(await nameOfRefusal(fs.ensureSkeleton())).toBe('NotFoundError')
        expect(await nameOfRefusal(fs.exists('pages', 'A.md'))).toBe('NotFoundError')
        expect(disk.at('Garden')).toBe(null)
    })

    it('scans a large graph in a handful of calls', async () => {
        const { fs, disk, native } = make()
        for (let n = 0; n < 250; n++) disk.write(`Garden/pages/Page ${n}.md`, `---\ntitle: Page ${n}\n---\n- one\n`)
        native.calls.length = 0
        const entries = await scanGraph(fs)
        expect(entries).toHaveLength(250)
        expect(native.calls.filter((call) => call.method === 'fs.read')).toEqual([])
        expect(native.calls.length).toBeLessThanOrEqual(7)
        native.calls.length = 0
        expect(await scanGraph(fs, { previous: entries })).toEqual(entries)
        expect(native.calls.map((call) => call.method)).not.toContain('fs.readMany')
    })
})

describe('the adapter of a Plain Folder', () => {
    const make = (options?: MemoryNativeOptions) => {
        const all = world(options)
        return { ...all, tree: createNativeTreeAdapter(all.folder, all.bridge) }
    }

    it('lists, reads and writes at any depth', async () => {
        const { tree, disk } = make()
        await tree.createDirectory('')
        await tree.createDirectory('guide/images')
        await tree.write('guide/watering.md', new TextEncoder().encode('# Watering'))
        expect(await tree.list('')).toEqual([{ name: 'guide', kind: 'directory' }])
        expect(disk.text('Garden/guide/watering.md')).toBe('# Watering')
        expect(await nameOfRefusal(tree.write('nowhere/a.md', new Uint8Array()))).toBe('NotFoundError')
    })

    it('reaches a decomposed name, and a name by another case, as the folder spells it', async () => {
        const { tree, disk } = make({ ignoreCase: true })
        disk.write(`Garden/${'Café'.normalize('NFD')}.md`, 'x')
        expect(await tree.canonicalPath('café.md'.normalize('NFD'))).toBe('Café.md')
        expect((await tree.list('')).map((entry) => entry.name)).toEqual(['Café.md'])
    })

    it('moves a directory whole and changes only its case', async () => {
        const { tree, disk } = make({ ignoreCase: true })
        disk.write('Garden/guide/images/bed.svg', 'x')
        await tree.move('guide', 'Guide')
        expect(disk.files('Garden')).toEqual(['Guide/images/bed.svg'])
        await tree.createDirectory('docs')
        await tree.move('Guide', 'docs/Guide')
        expect(disk.files('Garden')).toEqual(['docs/Guide/images/bed.svg'])
        disk.write('Garden/taken.md', 'x')
        expect(await nameOfRefusal(tree.move('docs', 'taken.md'))).toBe('InvalidModificationError')
    })

    it('hands out a directory as a folder of its own, and itself for the root', async () => {
        const { tree, folder, disk } = make()
        disk.write('Garden/docs/etherpk/settings.json', '{}')
        expect(await tree.directoryHandle!('')).toBe(folder)
        const docs = await tree.directoryHandle!('docs')
        expect(isNativeFolder(docs) && docs.name).toBe('docs')
        expect(await createNativeTreeAdapter(docs as NativeFolderRef, world().bridge).list('').catch((error: Error) => error.name)).toBe('NotAllowedError')
    })

    it('is indexed as any folder is', async () => {
        const { tree, disk } = make()
        for (const path of ['a.md', 'b/c.md', 'node_modules/x.js', '.git/HEAD', 'docs/etherpk/settings.json']) disk.write(`Garden/${path}`, 'x')
        const index = createFolderIndex(tree)
        await index.refresh()
        expect(index.files()).toEqual(['a.md', 'b/c.md', 'docs/etherpk/settings.json'])
        expect(index.graphFolders()).toEqual(['docs'])
    })
})

describe('one file opened on its own', () => {
    it('is read, written while it is as it was read, and refused when it is not', async () => {
        const { native, disk, bridge } = world()
        disk.write('Garden/notes.md', 'one')
        const tree = createSingleFileAdapter(nativeSingleFile(nativeFileRef(native.grantFile('Garden/notes.md')), bridge))
        const read = await tree.read('notes.md')
        const stamp = { lastModified: read.lastModified, size: read.size }
        expect(await tree.stat('notes.md')).toEqual({ kind: 'file', ...stamp })
        const written = await tree.write('notes.md', new TextEncoder().encode('two'), stamp)
        expect(disk.text('Garden/notes.md')).toBe('two')
        disk.write('Garden/notes.md', 'elsewhere')
        expect(await nameOfRefusal(tree.write('notes.md', new TextEncoder().encode('three'), written))).toBe('NoModificationAllowedError')
        expect(disk.text('Garden/notes.md')).toBe('elsewhere')
        expect(await nameOfRefusal(tree.write('other.md', new Uint8Array()))).toBe('NeedsFolderError')
    })
})

describe('a publish folder', () => {
    it('is written by the publisher’s own rules', async () => {
        const { folder, disk, bridge } = world()
        for (const [path, text] of [['old.html', 'x'], ['assets/old.png', 'x'], ['CNAME', 'docs.example.com'], ['.git/HEAD', 'ref'], ['README.md', 'mine']]) disk.write(`Garden/${path}`, text)
        const result = await writeSite(nativeSiteFolder(folder, bridge), new Map<string, string | Uint8Array>([['index.html', 'hello'], ['theme/a/b.css', 'body{}'], ['assets/x.png', new Uint8Array([1, 2])]]), {
            seeded: new Map([['README.md', 'seeded'], ['robots.txt', 'seeded']]),
            agentsMd: () => 'agents',
        })
        expect(result.deleted.sort()).toEqual(['assets/old.png', 'old.html'])
        expect(disk.files('Garden')).toEqual(['.git/HEAD', 'AGENTS.md', 'CNAME', 'README.md', 'assets/x.png', 'index.html', 'robots.txt', 'theme/a/b.css'])
        expect(disk.text('Garden/README.md')).toBe('mine')
        expect([...disk.read('Garden/assets/x.png')!]).toEqual([1, 2])
    })

    it('that cannot be read is not taken for one that has never been written', async () => {
        const { folder, native, bridge } = world()
        native.withdraw(folder.nativeId)
        expect(await nameOfRefusal(nativeSiteFolder(folder, bridge).readText('README.md'))).toBe('NotAllowedError')
    })
})

describe('an import’s source', () => {
    it('is every content file, without the junk, sorted', async () => {
        const { folder, disk, bridge } = world()
        for (const path of ['pages/Beans.md', '.git/HEAD', 'node_modules/a/b.js', 'assets/bed.png', '.DS_Store']) disk.write(`Garden/${path}`, path)
        const { files, unreadable } = await walkTree(createNativeTreeAdapter(folder, bridge))
        expect(files.map((file) => file.path)).toEqual(['assets/bed.png', 'pages/Beans.md'])
        expect(unreadable).toEqual([])
        expect(await files[1].data.text()).toBe('pages/Beans.md')
        await expect(walkTree(createNativeTreeAdapter(folder, bridge), AbortSignal.abort())).rejects.toThrow()
    })

    it('names a file it cannot read and keeps the rest', async () => {
        const { folder, disk, native, bridge } = world()
        for (const path of ['pages/Beans.md', 'pages/Peas.md', 'assets/bed.png']) disk.write(`Garden/${path}`, path)
        native.fail('fs.read', 'NotReadableError', { when: (args: { path: string }) => args.path.endsWith('pages/Peas.md') })
        const { files, unreadable } = await walkTree(createNativeTreeAdapter(folder, bridge))
        expect(files.map((file) => file.path)).toEqual(['assets/bed.png', 'pages/Beans.md'])
        expect(unreadable).toEqual(['pages/Peas.md'])
    })

    it('holds no more than a run of reads in flight at once', async () => {
        const { folder, disk, native, bridge } = world()
        for (let at = 0; at < 40; at++) disk.write(`Garden/pages/Page ${at}.md`, `- line ${at}`)
        let inFlight = 0
        let most = 0
        native.hook({
            before: async ({ method }) => {
                if (method !== 'fs.read') return undefined
                most = Math.max(most, ++inFlight)
                await new Promise((resolve) => setTimeout(resolve, 1))
                inFlight--
                return undefined
            },
        })
        expect((await walkTree(createNativeTreeAdapter(folder, bridge))).files).toHaveLength(40)
        expect(most).toBeLessThanOrEqual(16)
    })
})
