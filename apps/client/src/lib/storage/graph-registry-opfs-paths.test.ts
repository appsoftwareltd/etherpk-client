import { describe, expect, it, vi } from 'vitest'

import type { GraphRecord, GraphStoragePort } from './graph-registry'
import { withOpfsFoldersByPath } from './graph-registry-opfs-paths'

/** A stand-in directory handle: only what the wrapper touches. */
interface FakeDirectory {
    kind: 'directory'
    name: string
    getDirectoryHandle(name: string): Promise<FakeDirectory>
}

function directory(name: string, children: FakeDirectory[] = []): FakeDirectory {
    return {
        kind: 'directory',
        name,
        async getDirectoryHandle(child) {
            const found = children.find((entry) => entry.name === child)
            if (!found) throw new DOMException(`${child} is not there`, 'NotFoundError')
            return found
        },
    }
}

/** An OPFS root holding `children`; `resolve` answers only for its own folders, as the browser's does. */
function opfsRoot(children: FakeDirectory[]): FileSystemDirectoryHandle {
    const resolve = async (handle: FakeDirectory) => (children.includes(handle) ? [handle.name] : null)
    return { ...directory('', children), resolve } as unknown as FileSystemDirectoryHandle
}

/** The port beneath: an in-memory map that records exactly what was stored. */
function memoryPort(initial: GraphRecord[] = []) {
    const rows = new Map(initial.map((record) => [record.id, record]))
    const port: GraphStoragePort = {
        async getAll() {
            return [...rows.values()]
        },
        async put(record) {
            rows.set(record.id, record)
        },
        async delete(id) {
            rows.delete(id)
        },
    }
    return { port, rows }
}

const folderRecord = (id: string, handle: unknown): GraphRecord => ({ id, name: id, backend: 'filesystem', createdAt: 1, handle })

describe('withOpfsFoldersByPath', () => {
    it('stores a folder inside OPFS by its path, not its handle, since WebKit cannot store a handle', async () => {
        const demo = directory('graph-demo-graph')
        const root = opfsRoot([demo])
        const { port, rows } = memoryPort()

        await withOpfsFoldersByPath(port, async () => root).put(folderRecord('demo-graph', demo))

        expect(rows.get('demo-graph')?.handle).toEqual({ opfsPath: ['graph-demo-graph'] })
    })

    it('hands back the folder handle for a stored path', async () => {
        const demo = directory('graph-demo-graph')
        const root = opfsRoot([demo])
        const { port } = memoryPort([folderRecord('demo-graph', { opfsPath: ['graph-demo-graph'] })])

        const [record] = await withOpfsFoldersByPath(port, async () => root).getAll()

        expect(record.handle).toBe(demo)
    })

    it('stores a picked folder, which is not in OPFS, as the handle it is', async () => {
        const picked = directory('My Notes')
        const root = opfsRoot([])
        const { port, rows } = memoryPort()

        await withOpfsFoldersByPath(port, async () => root).put(folderRecord('mine', picked))

        expect(rows.get('mine')?.handle).toBe(picked)
    })

    it('leaves server records alone and never opens OPFS for them', async () => {
        const opfs = vi.fn(async () => opfsRoot([]))
        const server: GraphRecord = { id: 's', name: 's', backend: 'server', createdAt: 1, handle: { rootDocId: 'r' } }
        const { port, rows } = memoryPort()
        const wrapped = withOpfsFoldersByPath(port, opfs)

        await wrapped.put(server)
        expect(await wrapped.getAll()).toEqual([server])
        expect(rows.get('s')).toEqual(server)
        expect(opfs).not.toHaveBeenCalled()
    })

    it('stores the handle as it is when there is no OPFS to resolve it against', async () => {
        const picked = directory('My Notes')
        const { port, rows } = memoryPort()

        await withOpfsFoldersByPath(port, async () => {
            throw new DOMException('no private storage here', 'SecurityError')
        }).put(folderRecord('mine', picked))

        expect(rows.get('mine')?.handle).toBe(picked)
    })

    it('leaves out a graph whose OPFS folder is gone, and keeps every other graph', async () => {
        const root = opfsRoot([])
        const picked = directory('My Notes')
        const { port } = memoryPort([folderRecord('demo-graph', { opfsPath: ['graph-demo-graph'] }), folderRecord('mine', picked)])

        const records = await withOpfsFoldersByPath(port, async () => root).getAll()

        expect(records.map((record) => record.id)).toEqual(['mine'])
        expect(records[0].handle).toBe(picked)
    })

    it('keeps every other graph listed when OPFS cannot be opened at all', async () => {
        const picked = directory('My Notes')
        const { port } = memoryPort([folderRecord('demo-graph', { opfsPath: ['graph-demo-graph'] }), folderRecord('mine', picked)])
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

        const records = await withOpfsFoldersByPath(port, async () => {
            throw new DOMException('The operation failed for an unknown transient reason.', 'UnknownError')
        }).getAll()

        expect(records.map((record) => record.id)).toEqual(['mine'])
        expect(warn).toHaveBeenCalled()
        warn.mockRestore()
    })
})
