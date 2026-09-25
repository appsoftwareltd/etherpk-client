import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DirectoryAdapter } from '$lib/storage/fs/directory-adapter'
import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'

import { openHeadlessFolder, type HeadlessFolderDeps } from './headless-folder'
import type { HeadlessGraph } from './headless-graph'
import { createNodeDirectoryAdapter } from './node-directory-adapter'
import { editDocument, readDocument, search } from './tools'

/**
 * A local graph folder served headlessly ([[2026-09-18 Headless Client Serves A Local Folder]]):
 * the filesystem store over a directory adapter, the same index and tools as a synced graph, and
 * the two things a folder needs that a relay gave for free - finding edits made behind the
 * process's back, and knowing a write has reached the disk before saying so.
 */

const open: HeadlessGraph[] = []
const dirs: string[] = []

afterEach(async () => {
    await Promise.all(open.splice(0).map((g) => g.dispose()))
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

let clock = 1_700_000_000_000
const now = () => (clock += 1000)

async function folder(adapter: DirectoryAdapter, extra: Partial<HeadlessFolderDeps> = {}): Promise<HeadlessGraph> {
    const g = await openHeadlessFolder({ adapter, name: 'Notes', graphId: `folder-${Math.floor(performance.now() * 1000)}`, ...extra })
    open.push(g)
    return g
}

async function indexed(predicate: () => Promise<boolean> | boolean): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (await predicate()) return
        await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('index did not catch up')
}

describe('openHeadlessFolder', () => {
    it('lists the folder as documents, named after the folder, with the index built', async () => {
        const adapter = createMemoryDirectoryAdapter({
            now,
            seed: {
                pages: { 'Plan.md': '---\ntitle: Plan\n---\n- top [[Physics]]' },
                journals: { '2026-06-02.md': '- a day' },
            },
        })
        const g = await folder(adapter)

        expect(g.name).toBe('Notes')
        expect(g.store.listDocuments().map((i) => [i.concept, i.kind])).toEqual([
            ['2026-06-02', 'journal'],
            ['Plan', 'page'],
        ])
        await g.store.whenReady('Plan')
        expect(g.store.open('Plan').getText()).toBe('- top [[Physics]]')
        expect((await search(g, { query: 'top' })).results.map((r) => r.concept)).toEqual(['Plan'])
    })

    it('refresh() finds a page added, one changed and one removed behind its back, index included', async () => {
        const adapter = createMemoryDirectoryAdapter({ now, seed: { pages: { 'Plan.md': '---\ntitle: Plan\n---\n- top' } } })
        const g = await folder(adapter)
        await g.store.whenReady('Plan')

        await adapter.write('pages', 'New.md', '---\ntitle: New\n---\n- freshly written elsewhere')
        await adapter.write('pages', 'Plan.md', '---\ntitle: Plan\n---\n- top, edited elsewhere')
        await g.store.refresh()

        expect(g.store.listDocuments().map((i) => i.concept)).toEqual(['New', 'Plan'])
        expect(g.store.open('Plan').getText()).toBe('- top, edited elsewhere')
        expect((await search(g, { query: 'freshly' })).results.map((r) => r.concept)).toEqual(['New'])
        expect((await search(g, { query: 'edited' })).results.map((r) => r.concept)).toEqual(['Plan'])

        await adapter.remove('pages', 'New.md')
        await g.store.refresh()
        expect(g.store.listDocuments().map((i) => i.concept)).toEqual(['Plan'])
        await indexed(async () => (await search(g, { query: 'freshly' })).results.length === 0)
    })

    it('a tool reads what is on disk now, without an explicit refresh', async () => {
        const adapter = createMemoryDirectoryAdapter({ now, seed: { pages: { 'Plan.md': '---\ntitle: Plan\n---\n- top' } } })
        const g = await folder(adapter)
        expect((await readDocument(g, 'Plan')).text).toBe('- top')

        await adapter.write('pages', 'Plan.md', '---\ntitle: Plan\n---\n- changed on disk')
        expect((await readDocument(g, 'Plan')).text).toBe('- changed on disk')
    })

    it('a write tool returns once the bytes are on disk, and the file keeps its frontmatter', async () => {
        const adapter = createMemoryDirectoryAdapter({ now, seed: { pages: { 'Plan.md': '---\ntitle: Plan\n---\n- top' } } })
        const g = await folder(adapter)

        await editDocument(g, { concept: 'Plan', old: '- top', new: '- top\n  - child' })

        expect((await adapter.read('pages', 'Plan.md')).text).toBe('---\ntitle: Plan\n---\n- top\n  - child')
        expect(await g.settle()).toEqual({ settled: true })
    })

    it('a write that fails is a refusal naming the cause, and the edit is kept for a retry', async () => {
        const inner = createMemoryDirectoryAdapter({ now, seed: { pages: { 'Plan.md': '---\ntitle: Plan\n---\n- top' } } })
        let failing = true
        const adapter: DirectoryAdapter = {
            ...inner,
            write: (subdir, name, text) => {
                if (failing) return Promise.reject(Object.assign(new Error('disk full'), { name: 'QuotaExceededError' }))
                return inner.write(subdir, name, text)
            },
        }
        const warnings: string[] = []
        const g = await folder(adapter, { onWarning: (line) => warnings.push(line) })

        await expect(editDocument(g, { concept: 'Plan', old: '- top', new: '- edited' })).rejects.toMatchObject({
            code: 'not_settled',
            message: expect.stringContaining('Could not save “Plan”'),
        })
        expect((await inner.read('pages', 'Plan.md')).text).toBe('---\ntitle: Plan\n---\n- top')
        // The buffer keeps the edit: a read shows it, and the next settle retries the write.
        expect((await readDocument(g, 'Plan')).text).toBe('- edited')
        failing = false
        expect(await g.settle()).toEqual({ settled: true })
        expect((await inner.read('pages', 'Plan.md')).text).toBe('---\ntitle: Plan\n---\n- edited')
        expect(warnings.some((line) => line.includes('Plan'))).toBe(true)
    })

    it('after a failed write, an external edit wins: the file is reloaded and the lost edit is logged', async () => {
        const inner = createMemoryDirectoryAdapter({ now, seed: { pages: { 'Plan.md': '---\ntitle: Plan\n---\n- top' } } })
        let failing = true
        const adapter: DirectoryAdapter = {
            ...inner,
            write: (subdir, name, text) => (failing ? Promise.reject(new Error('EACCES')) : inner.write(subdir, name, text)),
        }
        const warnings: string[] = []
        const g = await folder(adapter, { onWarning: (line) => warnings.push(line) })
        await expect(editDocument(g, { concept: 'Plan', old: '- top', new: '- mine' })).rejects.toMatchObject({ code: 'not_settled' })

        await inner.write('pages', 'Plan.md', '---\ntitle: Plan\n---\n- theirs')
        failing = false
        expect((await readDocument(g, 'Plan')).text).toBe('- theirs')
        expect((await inner.read('pages', 'Plan.md')).text).toBe('---\ntitle: Plan\n---\n- theirs')
        expect(warnings.some((line) => /took the file on disk|discarded/i.test(line))).toBe(true)
    })

    it('the watcher feeds the same reconcile, coalescing a burst into one pass', async () => {
        const adapter = createMemoryDirectoryAdapter({ now, seed: { pages: { 'Plan.md': '---\ntitle: Plan\n---\n- top' } } })
        let fire: (() => void) | undefined
        const stop = vi.fn()
        const g = await folder(adapter, {
            watch: (trigger) => {
                fire = trigger
                return stop
            },
            watchDebounceMs: 10,
        })
        await adapter.write('pages', 'Plan.md', '---\ntitle: Plan\n---\n- watched change')
        fire!()
        fire!()
        fire!()
        await indexed(async () => (await search(g, { query: 'watched' })).results.length === 1)
        await g.store.whenReady('Plan')
        expect(g.store.open('Plan').getText()).toBe('- watched change')

        await g.dispose()
        open.pop()
        expect(stop).toHaveBeenCalledTimes(1)
    })

    it('keeps the index and vectors under persistDir and nothing else, and never writes into the folder', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-folder-'))
        dirs.push(dir)
        const cacheDir = await mkdtemp(join(tmpdir(), 'etherpk-mcp-folder-cache-'))
        dirs.push(cacheDir)
        const adapter = createNodeDirectoryAdapter(dir)
        await adapter.ensureSkeleton()
        await writeFile(join(dir, 'pages', 'Plan.md'), '---\ntitle: Plan\n---\n- top')
        const before = (await readdir(dir)).sort()

        const g = await folder(adapter, { persistDir: cacheDir })
        await editDocument(g, { concept: 'Plan', old: '- top', new: '- top\n- more' })
        await g.dispose()
        open.pop()

        expect((await readdir(dir)).sort()).toEqual(before)
        expect(await readFile(join(dir, 'pages', 'Plan.md'), 'utf8')).toBe('---\ntitle: Plan\n---\n- top\n- more')
        const cached = (await readdir(cacheDir)).sort()
        expect(cached.some((name) => /^index\.v\d+\.sqlite$/.test(name))).toBe(true)
        expect(cached.some((name) => /^vectors\.v\d+\.sqlite$/.test(name))).toBe(true)
        expect(cached.some((name) => name.startsWith('local-cache'))).toBe(false)
    })
})

describe('openHeadlessFolder - a browser saving into the same folder', () => {
    /**
     * A pass is two listings (the signature) and, only when something moved, two more from the
     * store's rescan: the count of `list` calls says whether the rescan ran.
     */
    function countingLists(adapter: DirectoryAdapter): { counted: DirectoryAdapter; lists: () => number } {
        let calls = 0
        const counted: DirectoryAdapter = {
            ...adapter,
            list: async (subdir) => {
                calls += 1
                return adapter.list(subdir)
            },
        }
        return { counted, lists: () => calls }
    }

    it('a swap file appearing beside a document starts no rescan; the document changing does', async () => {
        const adapter = createMemoryDirectoryAdapter({ now, seed: { pages: { 'Plan.md': '---\ntitle: Plan\n---\n- top' } } })
        const { counted, lists } = countingLists(adapter)
        let fire: (() => void) | undefined
        await folder(counted, {
            watch: (trigger) => {
                fire = trigger
                return () => {}
            },
            watchDebounceMs: 10,
        })
        const before = lists()

        // Chrome writes `Plan.md.crswap` while a person types in the browser, then renames it
        // over `Plan.md` when the save lands. The watcher sees the swap file first.
        await adapter.write('pages', 'Plan.md.crswap', '---\ntitle: Plan\n---\n- half typed')
        fire!()
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(lists() - before).toBe(2)

        // No tool call here: each one runs a pass of its own, which would add listings.
        await adapter.write('pages', 'Plan.md', '---\ntitle: Plan\n---\n- landed')
        fire!()
        await indexed(() => lists() - before === 6)
        await new Promise((resolve) => setTimeout(resolve, 60))
        expect(lists() - before).toBe(6)
    })
})
