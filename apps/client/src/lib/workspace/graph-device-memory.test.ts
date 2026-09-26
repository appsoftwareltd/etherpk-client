import { describe, expect, it, vi } from 'vitest'

import type { GraphRecord } from '$lib/storage'

import { forgetGraphOnDevice, graphDeviceMemoryKeys, type ForgetGraphDeps } from './graph-device-memory'

function memoryStorage(entries: Record<string, string>): Storage {
    const values = new Map(Object.entries(entries))
    return {
        get length() {
            return values.size
        },
        key: (index: number) => [...values.keys()][index] ?? null,
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
        removeItem: (key: string) => void values.delete(key),
        clear: () => values.clear(),
    }
}

const synced: GraphRecord = {
    id: 'g1',
    name: 'Team notes',
    backend: 'server',
    createdAt: 1,
    handle: { rootDocId: 'root-g1' },
    serverScope: { serverOrigin: 'https://sync.example.com', principalId: 'p1' },
    membershipActive: true,
}

function deps(storage: Storage, lastGraph: string | null = null): ForgetGraphDeps & { calls: string[] } {
    const calls: string[] = []
    let last = lastGraph
    return {
        calls,
        storage,
        deleteGraphCache: vi.fn(async (id: string) => void calls.push(`cache ${id}`)),
        discardIndex: vi.fn((id: string) => void calls.push(`index ${id}`)),
        forgetMirrorFolder: vi.fn(async (id: string) => void calls.push(`mirror ${id}`)),
        removeRecord: vi.fn(async (id: string) => void calls.push(`record ${id}`)),
        lastGraphId: () => last,
        clearLastGraphId: () => {
            last = null
            calls.push('last graph')
        },
    }
}

describe('forgetGraphOnDevice', () => {
    // Recents and the layout carry document titles, so a removed graph leaves none behind.
    it('removes a synced graph\'s copy, index, mirror link, record and everything remembered about it', async () => {
        const remembered = Object.fromEntries(graphDeviceMemoryKeys('g1').map((key) => [key, 'x']))
        const storage = memoryStorage({ ...remembered, 'etherpk-recents:other': 'kept' })
        const forget = deps(storage, 'g1')

        await forgetGraphOnDevice(synced, forget)

        expect(forget.calls).toEqual(['cache g1', 'mirror g1', 'index g1', 'record g1', 'last graph'])
        for (const key of graphDeviceMemoryKeys('g1')) expect(storage.getItem(key)).toBeNull()
        expect(storage.getItem('etherpk-recents:other')).toBe('kept')
    })

    it('leaves a folder graph\'s files alone and forgets only what the browser holds', async () => {
        const folder: GraphRecord = { id: 'f1', name: 'Local', backend: 'filesystem', createdAt: 1, handle: {} }
        const storage = memoryStorage({ 'etherpk-layout:f1': 'x' })
        const forget = deps(storage, 'someone-else')

        await forgetGraphOnDevice(folder, forget)

        expect(forget.calls).toEqual(['index f1', 'record f1'])
        expect(storage.getItem('etherpk-layout:f1')).toBeNull()
    })

    it('names every per-graph key the workspace writes', () => {
        expect(graphDeviceMemoryKeys('g1')).toEqual([
            'etherpk-recents:g1',
            'etherpk-layout:g1',
            'etherpk-positions:g1',
            'etherpk-backlinks:g1',
            'etherpk-task-filter:g1',
            'etherpk-settings-tab:g1',
            'etherpk-last-publication:g1',
            'etherpk:spelling-languages:g1',
            'etherpk:protection:g1',
            'etherpk-folder-path:g1',
        ])
    })
})
