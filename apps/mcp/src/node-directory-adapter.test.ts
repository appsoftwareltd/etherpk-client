import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SUBDIRS } from '$lib/storage/fs/directory-adapter'

import { createNodeDirectoryAdapter, isGraphFolder } from './node-directory-adapter'

/**
 * The [[DirectoryAdapter]] over a real directory through `node:fs`, matching the semantics the
 * browser adapter gives the filesystem store: mtimes in epoch milliseconds, sizes in bytes as a
 * listing reports them, files only (never directories) in a listing, a write that answers with
 * the post-write stamp, and a root-file read that distinguishes "absent" from "unreadable".
 */

const dirs: string[] = []

afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function folder(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-folder-'))
    dirs.push(dir)
    return dir
}

describe('createNodeDirectoryAdapter', () => {
    it('creates the skeleton once and lists only the files directly under a subdir', async () => {
        const dir = await folder()
        const adapter = createNodeDirectoryAdapter(dir)

        await adapter.ensureSkeleton()
        expect((await readdir(dir)).sort()).toEqual([...SUBDIRS].sort())
        await adapter.ensureSkeleton() // idempotent

        await writeFile(join(dir, 'pages', 'Plan.md'), '- top')
        await mkdir(join(dir, 'pages', 'nested'))
        await writeFile(join(dir, 'pages', 'nested', 'Deep.md'), '- deep')
        const listed = await adapter.list('pages')
        expect(listed.map((entry) => entry.name)).toEqual(['Plan.md'])
        expect(listed[0].size).toBe(5)
        expect(listed[0].lastModified).toBeGreaterThan(0)
    })

    it('writes text and reports the post-write stamp the next listing will show', async () => {
        const dir = await folder()
        const adapter = createNodeDirectoryAdapter(dir)
        await adapter.ensureSkeleton()

        const written = await adapter.write('journals', '2026-06-02.md', '- é day\n')
        const [entry] = await adapter.list('journals')
        expect(entry).toEqual({ name: '2026-06-02.md', lastModified: written.lastModified, size: written.size })
        // Bytes, not code units: the accented character is two.
        expect(written.size).toBe(Buffer.byteLength('- é day\n'))
        expect(await adapter.read('journals', '2026-06-02.md')).toEqual({ text: '- é day\n', lastModified: written.lastModified, size: written.size })
        expect(await readFile(join(dir, 'journals', '2026-06-02.md'), 'utf8')).toBe('- é day\n')
    })

    it('round-trips binary bytes and reads them as a copy the caller may keep', async () => {
        const dir = await folder()
        const adapter = createNodeDirectoryAdapter(dir)
        await adapter.ensureSkeleton()
        const bytes = new Uint8Array([0, 255, 1, 254, 137, 80, 78, 71])

        const written = await adapter.writeBinary('assets', 'blob.png', bytes)
        expect(written.lastModified).toBeGreaterThan(0)
        const read = await adapter.readBinary('assets', 'blob.png')
        expect([...read.bytes]).toEqual([...bytes])
        expect(read.bytes.buffer.byteLength).toBe(bytes.length)
        expect(read.lastModified).toBe(written.lastModified)
    })

    it('answers exists and remove quietly for absent files, and rejects a read of one', async () => {
        const dir = await folder()
        const adapter = createNodeDirectoryAdapter(dir)
        await adapter.ensureSkeleton()

        expect(await adapter.exists('pages', 'Nope.md')).toBe(false)
        await expect(adapter.remove('pages', 'Nope.md')).resolves.toBeUndefined()
        await expect(adapter.read('pages', 'Nope.md')).rejects.toThrow()
        await adapter.write('pages', 'Yes.md', 'x')
        expect(await adapter.exists('pages', 'Yes.md')).toBe(true)
        await adapter.remove('pages', 'Yes.md')
        expect(await adapter.exists('pages', 'Yes.md')).toBe(false)
    })

    it('reads a root file as null when absent, and rethrows when it exists but cannot be read', async () => {
        const dir = await folder()
        const adapter = createNodeDirectoryAdapter(dir)

        expect(await adapter.readRootFile('AGENTS.md')).toBeNull()
        const written = await adapter.writeRootFile('AGENTS.md', '# Agents\n')
        expect(await adapter.readRootFile('AGENTS.md')).toEqual({ text: '# Agents\n', lastModified: written.lastModified, size: 9 })
        // A directory where a file was expected is "cannot read", never "absent".
        await mkdir(join(dir, 'CLAUDE.md'))
        await expect(adapter.readRootFile('CLAUDE.md')).rejects.toThrow()
    })

    it('reports an mtime that follows an external touch, in whole milliseconds, so the store can see a change', async () => {
        const dir = await folder()
        const adapter = createNodeDirectoryAdapter(dir)
        await adapter.ensureSkeleton()
        const written = await adapter.write('pages', 'Plan.md', '- top')
        expect(Number.isInteger(written.lastModified)).toBe(true)

        // A fractional-millisecond instant: Node may report it as a float a hair under the
        // millisecond, and the adapter must still answer the same integer for it every time.
        const later = new Date(written.lastModified + 60_000)
        await utimes(join(dir, 'pages', 'Plan.md'), later, later)
        const [entry] = await adapter.list('pages')
        expect(entry.lastModified).toBe(later.getTime())
        expect((await adapter.read('pages', 'Plan.md')).lastModified).toBe(entry.lastModified)
    })
})

describe('isGraphFolder', () => {
    it('recognises a folder by its pages and journals subdirectories, and refuses anything else', async () => {
        const dir = await folder()
        expect(await isGraphFolder(dir)).toBe(false)
        await mkdir(join(dir, 'pages'))
        expect(await isGraphFolder(dir)).toBe(false)
        await mkdir(join(dir, 'journals'))
        expect(await isGraphFolder(dir)).toBe(true)
        expect(await isGraphFolder(join(dir, 'missing'))).toBe(false)
        await writeFile(join(dir, 'file.txt'), 'x')
        expect(await isGraphFolder(join(dir, 'file.txt'))).toBe(false)
    })
})
