import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { nodeSiteFolder } from './publish-environment'
import { parsePublishFolders, publishFolderOf, publishGraphKey, readPublishFolders, withPublishFolder, writePublishFolders } from './publish-folders'

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
