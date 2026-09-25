import { describe, expect, it, vi } from 'vitest'

import { createMemoryDirectoryAdapter } from '$lib/storage/fs/memory-adapter'
import { type GraphRecord, type GraphStoragePort, createGraphRegistry } from '$lib/storage/graph-registry'

import type { DemoBundleManifest } from './bundle-manifest'
import { DEMO_GRAPH_FOLDER, DEMO_GRAPH_ID, type DemoGraphDeps, isDemoGraph, openDemoGraph, planDemoOpen } from './demo-graph'
import type { DemoFile } from './seed'

const encoder = new TextEncoder()
const manifest: DemoBundleManifest = {
    name: 'Plants (demo)',
    anchor: '2026-09-15',
    windowDays: 60,
    files: [
        { path: 'journals/2026-09-15.md', size: 12 },
        { path: 'pages/Plant.md', size: 7 },
    ],
    totalBytes: 19,
}
const bundle = (): DemoFile[] => [
    { path: 'journals/2026-09-15.md', bytes: encoder.encode('# 2026-09-15') as Uint8Array<ArrayBuffer> },
    { path: 'pages/Plant.md', bytes: encoder.encode('# Plant') as Uint8Array<ArrayBuffer> },
]

function memoryPort(): GraphStoragePort {
    const rows = new Map<string, GraphRecord>()
    return {
        getAll: async () => [...rows.values()],
        put: async (record) => void rows.set(record.id, record),
        delete: async (id) => void rows.delete(id),
    }
}

function domException(name: string): Error {
    const error = new Error(name)
    error.name = name
    return error
}

/** An OPFS root holding named subfolders, each backed by its own in-memory adapter. */
function fakeRoot() {
    const folders = new Map<string, FileSystemDirectoryHandle>()
    const adapters = new Map<FileSystemDirectoryHandle, ReturnType<typeof createMemoryDirectoryAdapter>>()
    const root = {
        async getDirectoryHandle(name: string, options?: { create?: boolean }) {
            let handle = folders.get(name)
            if (!handle) {
                if (!options?.create) throw domException('NotFoundError')
                handle = { kind: 'directory', name } as FileSystemDirectoryHandle
                folders.set(name, handle)
                adapters.set(handle, createMemoryDirectoryAdapter({ now: () => 1 }))
            }
            return handle
        },
        async removeEntry(name: string) {
            const handle = folders.get(name)
            if (!handle) throw domException('NotFoundError')
            folders.delete(name)
            adapters.delete(handle)
        },
    } as unknown as FileSystemDirectoryHandle
    return {
        root,
        adapterFor: (handle: FileSystemDirectoryHandle) => {
            const adapter = adapters.get(handle)
            if (!adapter) throw new Error('unknown handle')
            return adapter
        },
        has: (name: string) => folders.has(name),
        folderAdapter: (name: string) => {
            const handle = folders.get(name)
            return handle ? adapters.get(handle) : undefined
        },
    }
}

function depsWith(overrides: Partial<DemoGraphDeps> = {}) {
    const fs = fakeRoot()
    const registry = createGraphRegistry(memoryPort())
    const discardIndex = vi.fn(async () => ({ kind: 'discarded' as const }))
    const deps: DemoGraphDeps = {
        registry,
        opfsRoot: async () => fs.root,
        adapterFor: fs.adapterFor,
        manifest,
        files: () => bundle(),
        today: () => '2026-10-01',
        now: () => 1234,
        claimLock: async () => () => {},
        discardIndex,
        ...overrides,
    }
    return { deps, fs, registry, discardIndex }
}

describe('identity', () => {
    it('recognises the fixed id and nothing else', () => {
        expect(isDemoGraph(DEMO_GRAPH_ID)).toBe(true)
        expect(isDemoGraph('demo')).toBe(false)
        expect(isDemoGraph(undefined)).toBe(false)
        expect(DEMO_GRAPH_FOLDER).toBe(`graph-${DEMO_GRAPH_ID}`)
    })
})

describe('planDemoOpen', () => {
    it('reopens only a record that still has its folder', () => {
        expect(planDemoOpen({ hasRecord: true, hasFolder: true, reset: false })).toBe('open')
        expect(planDemoOpen({ hasRecord: true, hasFolder: false, reset: false })).toBe('rebuild')
        expect(planDemoOpen({ hasRecord: false, hasFolder: true, reset: false })).toBe('rebuild')
        expect(planDemoOpen({ hasRecord: false, hasFolder: false, reset: false })).toBe('rebuild')
        expect(planDemoOpen({ hasRecord: true, hasFolder: true, reset: true })).toBe('rebuild')
    })
})

describe('openDemoGraph', () => {
    it('seeds a fresh browser: folder, shifted content, then the record last', async () => {
        const { deps, fs, registry } = depsWith()
        const outcome = await openDemoGraph(deps, { reset: false })
        expect(outcome).toEqual({ kind: 'ready', plan: 'rebuild' })
        const record = await registry.getGraph(DEMO_GRAPH_ID)
        expect(record).toMatchObject({ id: DEMO_GRAPH_ID, name: 'Plants (demo)', backend: 'filesystem', createdAt: 1234 })
        expect(record?.handle).toBe(await fs.root.getDirectoryHandle(DEMO_GRAPH_FOLDER))
        const adapter = fs.folderAdapter(DEMO_GRAPH_FOLDER)!
        expect((await adapter.read('journals', '2026-10-01.md')).text).toBe('# 2026-10-01')
        expect((await adapter.read('pages', 'Plant.md')).text).toBe('# Plant')
    })

    it('reopens an existing demo without touching it', async () => {
        const { deps, fs, discardIndex } = depsWith()
        await openDemoGraph(deps, { reset: false })
        const adapter = fs.folderAdapter(DEMO_GRAPH_FOLDER)!
        await adapter.write('pages', 'Mine.md', '# Mine')
        discardIndex.mockClear()
        const outcome = await openDemoGraph(deps, { reset: false })
        expect(outcome).toEqual({ kind: 'ready', plan: 'open' })
        expect(await adapter.exists('pages', 'Mine.md')).toBe(true)
        expect(discardIndex).not.toHaveBeenCalled()
    })

    it('resets: drops the folder and the index, re-seeds, and the visitor edits are gone', async () => {
        const { deps, fs, discardIndex } = depsWith()
        await openDemoGraph(deps, { reset: false })
        await fs.folderAdapter(DEMO_GRAPH_FOLDER)!.write('pages', 'Mine.md', '# Mine')
        const outcome = await openDemoGraph(deps, { reset: true })
        expect(outcome).toEqual({ kind: 'ready', plan: 'rebuild' })
        expect(discardIndex).toHaveBeenCalledWith(DEMO_GRAPH_ID)
        const adapter = fs.folderAdapter(DEMO_GRAPH_FOLDER)!
        expect(await adapter.exists('pages', 'Mine.md')).toBe(false)
        expect(await adapter.exists('pages', 'Plant.md')).toBe(true)
    })

    it('rebuilds after eviction: the record is there but the folder is not', async () => {
        const { deps, fs, registry } = depsWith()
        await openDemoGraph(deps, { reset: false })
        await fs.root.removeEntry(DEMO_GRAPH_FOLDER)
        const outcome = await openDemoGraph(deps, { reset: false })
        expect(outcome).toEqual({ kind: 'ready', plan: 'rebuild' })
        expect(fs.has(DEMO_GRAPH_FOLDER)).toBe(true)
        expect(await registry.getGraph(DEMO_GRAPH_ID)).toBeDefined()
    })

    it('refuses a rebuild while another tab owns the demo, touching nothing', async () => {
        const { deps, fs } = depsWith()
        await openDemoGraph(deps, { reset: false })
        await fs.folderAdapter(DEMO_GRAPH_FOLDER)!.write('pages', 'Mine.md', '# Mine')
        const held = { ...deps, claimLock: async () => null }
        expect(await openDemoGraph(held, { reset: true })).toEqual({ kind: 'held' })
        expect(await fs.folderAdapter(DEMO_GRAPH_FOLDER)!.exists('pages', 'Mine.md')).toBe(true)
        expect(await deps.registry.getGraph(DEMO_GRAPH_ID)).toBeDefined()
    })

    it('answers held and releases the lock when the index pool will not let go', async () => {
        const release = vi.fn()
        const { deps } = depsWith({
            claimLock: async () => release,
            discardIndex: async () => ({ kind: 'held' as const }),
        })
        expect(await openDemoGraph(deps, { reset: false })).toEqual({ kind: 'held' })
        expect(release).toHaveBeenCalledTimes(1)
    })

    it('leaves no record behind when the seed fails part-way', async () => {
        const { deps, registry } = depsWith({
            files: () => {
                throw new Error('network gone')
            },
        })
        await expect(openDemoGraph(deps, { reset: false })).rejects.toThrow('network gone')
        expect(await registry.getGraph(DEMO_GRAPH_ID)).toBeUndefined()
    })

    it('reports progress against the manifest total', async () => {
        const seen: number[] = []
        const { deps } = depsWith()
        await openDemoGraph(deps, { reset: false, onProgress: (p) => seen.push(p.totalBytes) })
        expect(seen).toEqual([19, 19])
    })
})
