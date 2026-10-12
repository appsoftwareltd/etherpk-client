import { mkdir, mkdtemp, readFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'

import { describe, expect, it } from 'vitest'

import { nodeSiteFolder } from './publish-environment'
import {
    parsePublishFolders,
    publishFolderOf,
    publishFolderOverlap,
    publishGraphKey,
    readPublishFolders,
    relateFolders,
    withPublishFolder,
    writePublishFolders,
} from './publish-folders'

/** The Publish Folder configuration (ADR 0086): a person's setting, keyed so graphs never share one. */
describe('publish folders', () => {
    it('keys a synced graph by server host and id, and a folder by its path hash', () => {
        const synced = publishGraphKey({ kind: 'synced', server: 'sync.example.com' }, 'g-1')
        expect(synced).toBe('sync.example.com/g-1')
        const folder = publishGraphKey({ kind: 'folder', path: '/home/me/notes' }, 'ignored')
        expect(folder).toMatch(/^local\/notes-[0-9a-f]{12}$/)
        expect(publishGraphKey({ kind: 'folder', path: '/home/me/other' }, 'ignored')).not.toBe(folder)
    })

    it('round-trips through the file and tolerates a hand-edited one', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-folders-'))
        const path = join(dir, 'nested', 'publish.json')
        expect(await readPublishFolders(path)).toEqual({ folders: {} })

        let folders = withPublishFolder({ folders: {} }, 'host/g1', 'docs', '/sites/docs')
        folders = withPublishFolder(folders, 'host/g1', 'blog', '/sites/blog')
        folders = withPublishFolder(folders, 'local/notes-abc', 'docs', '/elsewhere')
        await writePublishFolders(path, folders)
        expect(await readPublishFolders(path)).toEqual(folders)
        expect(publishFolderOf(folders, 'host/g1', 'blog')).toBe('/sites/blog')
        expect(publishFolderOf(folders, 'host/g1', 'nope')).toBeNull()
        expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(folders)

        // Relative paths and junk are dropped, never thrown on.
        expect(parsePublishFolders('{"folders":{"a/b":{"docs":"relative/path","blog":"/ok"},"bad":"x","c/d":{"e":3}}}')).toEqual({ folders: { 'a/b': { blog: '/ok' } } })
        expect(parsePublishFolders('not json')).toEqual({ folders: {} })
    })
})

/**
 * A publish deletes the files it did not write from the folder it writes into (`isOwnedPath`), so
 * a Publish Folder that is a graph folder, sits inside one or holds one would lose the graph's
 * files. The same three relations the Local Mirror refuses.
 */
describe('a publish folder against the graph folder', () => {
    it('relates two absolute paths by their segments, not their spelling', () => {
        expect(relateFolders('/home/me/notes', '/home/me/notes')).toBe('same')
        expect(relateFolders('/home/me/notes', '/home/me/notes/')).toBe('same')
        expect(relateFolders('/home/me/notes', '/home/me/notes/site')).toBe('inside')
        expect(relateFolders('/home/me/notes', '/home/me/notes/assets/site')).toBe('inside')
        expect(relateFolders('/home/me/notes', '/home/me')).toBe('contains')
        expect(relateFolders('/home/me/notes', '/')).toBe('contains')
        // A shared prefix is not a parent: notes-site is a sibling of notes.
        expect(relateFolders('/home/me/notes', '/home/me/notes-site')).toBeNull()
        expect(relateFolders('/home/me/notes', '/srv/site')).toBeNull()
    })

    it('ignores case where the filesystem does', () => {
        expect(relateFolders('/Users/me/Notes', '/users/me/notes/site', { caseInsensitive: true })).toBe('inside')
        expect(relateFolders('/Users/me/Notes', '/users/me/notes/site', { caseInsensitive: false })).toBeNull()
    })

    // Nothing in CI runs on Windows, and Windows users run the Headless Client.
    it('reads Windows paths with Windows rules', () => {
        expect(relateFolders('C:\\Users\\me\\Notes', 'c:\\users\\me\\notes', { path: win32 })).toBe('same')
        expect(relateFolders('C:\\Users\\me\\Notes', 'C:\\Users\\me\\Notes\\site', { path: win32 })).toBe('inside')
        expect(relateFolders('C:\\Users\\me\\Notes', 'C:\\', { path: win32 })).toBe('contains')
        expect(relateFolders('C:\\Users\\me\\Notes', 'D:\\Users\\me\\Notes', { path: win32 })).toBeNull()
        expect(relateFolders('C:\\Users\\me\\Notes', 'C:\\Users\\me\\Notes-site', { path: win32 })).toBeNull()
    })

    it('follows symbolic links, including above a folder that does not exist yet', async () => {
        const root = await mkdtemp(join(tmpdir(), 'etherpk-mcp-overlap-'))
        const graph = join(root, 'notes')
        await mkdir(join(graph, 'pages'), { recursive: true })
        await symlink(graph, join(root, 'linked'))
        expect(await publishFolderOverlap(graph, join(root, 'linked'))).toBe('same')
        expect(await publishFolderOverlap(graph, join(root, 'linked', 'site', 'deeper'))).toBe('inside')
        expect(await publishFolderOverlap(join(root, 'linked'), root)).toBe('contains')
        expect(await publishFolderOverlap(graph, join(root, 'site'))).toBeNull()
    })
})

describe('the site folder over the filesystem', () => {
    it('reads, writes, lists and removes under the root and nowhere else', async () => {
        const root = await mkdtemp(join(tmpdir(), 'etherpk-mcp-site-'))
        const folder = nodeSiteFolder(root)
        expect(await folder.readText('index.html')).toBeNull()
        await folder.writeFile('index.html', '<p>hi</p>')
        await folder.writeFile('assets/deep/one.bin', new Uint8Array([1, 2, 3]))
        await folder.writeFile('.git/config', 'ignored')
        expect(await folder.readText('index.html')).toBe('<p>hi</p>')
        expect(await folder.readBytes('assets/deep/one.bin')).toEqual(new Uint8Array([1, 2, 3]))
        expect((await folder.listFiles()).sort()).toEqual(['assets/deep/one.bin', 'index.html'])
        await folder.remove('index.html')
        await folder.remove('never-there.html')
        expect(await folder.listFiles()).toEqual(['assets/deep/one.bin'])
        await expect(folder.writeFile('../escape.html', 'x')).rejects.toThrow('outside the publish folder')
    })
})
