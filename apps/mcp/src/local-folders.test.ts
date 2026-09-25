import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { FolderRefused, folderUnder, previewRequestAllowed } from './local-folders'

const made: string[] = []
afterEach(async () => {
    await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function temp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-folders-'))
    made.push(dir)
    return dir
}

describe('folderUnder', () => {
    it('places a named folder, or the default, under the base', async () => {
        const base = join(await temp(), 'downloads')
        expect(await folderUnder(base, 'previews/mine', 'previews/default')).toBe(join(base, 'previews', 'mine'))
        expect(await folderUnder(base, undefined, 'previews/default')).toBe(join(base, 'previews', 'default'))
        expect(await folderUnder(base, '  ', 'x')).toBe(join(base, 'x'))
        expect(await folderUnder(base, join(base, 'themes', 'blog'), 'x')).toBe(join(base, 'themes', 'blog'))
    })

    it('refuses a folder that resolves outside the base', async () => {
        const root = await temp()
        const base = join(root, 'downloads')
        for (const requested of ['../escaped', '/etc', join(root, 'beside'), 'a/../../escaped']) {
            await expect(folderUnder(base, requested, 'x')).rejects.toBeInstanceOf(FolderRefused)
        }
    })

    it('refuses a path that leaves the base through a symbolic link', async () => {
        const root = await temp()
        const base = join(root, 'downloads')
        const outside = join(root, 'outside')
        await mkdir(base, { recursive: true })
        await mkdir(outside, { recursive: true })
        await symlink(outside, join(base, 'link'))
        await expect(folderUnder(base, 'link/sub', 'x')).rejects.toBeInstanceOf(FolderRefused)
    })
})

describe('previewRequestAllowed', () => {
    it('lets a preview load its own files and inline data, and nothing from the network or elsewhere on disk', () => {
        const folder = '/home/me/.cache/etherpk/mcp/g/downloads/previews/blog'
        expect(previewRequestAllowed('file:///home/me/.cache/etherpk/mcp/g/downloads/previews/blog/index.html', folder)).toBe(true)
        expect(previewRequestAllowed('file:///home/me/.cache/etherpk/mcp/g/downloads/previews/blog/theme/theme.css', folder)).toBe(true)
        expect(previewRequestAllowed('data:image/png;base64,AAAA', folder)).toBe(true)
        expect(previewRequestAllowed('about:blank', folder)).toBe(true)
        for (const url of [
            'https://plausible.io/js/script.js',
            'http://127.0.0.1:8080/admin',
            'http://169.254.169.254/latest/meta-data/',
            'file:///etc/passwd',
            'file:///home/me/.cache/etherpk/mcp/g/downloads/previews/blog-other/index.html',
            'ws://localhost:5173',
        ]) {
            expect(previewRequestAllowed(url, folder)).toBe(false)
        }
    })
})
