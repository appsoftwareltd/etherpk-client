import { describe, expect, it, vi } from 'vitest'

import type { GraphRecord } from '$lib/storage'

import { createGraphKeyring, toBase64Url } from '$lib/crypto'
import { sealGraphName } from '$lib/sync/graph-name-envelope'

import { loadSyncedGraphViews, persistableGraphRecord, unlabelledGraphsToRead, type SyncedGraphView } from './graph-picker-helpers'

describe('graph picker helpers', () => {
    it('rebuilds server handles as clone-safe plain records', () => {
        const record: GraphRecord = {
            id: 'graph-a',
            name: 'Old name',
            backend: 'server',
            createdAt: 42,
            handle: { rootDocId: 'root-a' },
        }

        const persisted = persistableGraphRecord(record, 'New name')

        expect(persisted).toEqual({ ...record, name: 'New name' })
        expect(persisted.handle).not.toBe(record.handle)
    })

    it('retains the browser-owned filesystem handle', () => {
        const handle = { name: 'notes' } as FileSystemDirectoryHandle
        const record: GraphRecord = {
            id: 'graph-a',
            name: 'Old name',
            backend: 'filesystem',
            createdAt: 42,
            handle,
        }

        expect(persistableGraphRecord(record, 'New name').handle).toBe(handle)
    })

    it('projects server memberships with local names and isolated member failures', async () => {
        const api = {
            graphsOverview: vi.fn().mockResolvedValue({
                graphs: [
                    {
                        id: 'owned',
                        rootDocId: 'root-owned',
                        role: 'owner',
                        storage: { docBytes: 10, assetBytes: 20 },
                    },
                    {
                        id: 'shared',
                        rootDocId: 'root-shared',
                        role: 'player',
                    },
                ],
                ownedStorage: { graphs: 1, docBytes: 10, assetBytes: 20 },
            }),
            graphMembers: vi.fn().mockRejectedValue(new Error('offline')),
        }
        const local = [
            {
                id: 'owned',
                name: 'My graph',
                backend: 'server',
                createdAt: 42,
                handle: { rootDocId: 'root-owned' },
            },
        ] as GraphRecord[]

        await expect(loadSyncedGraphViews(api, local)).resolves.toEqual({
            graphs: [
                {
                    id: 'owned',
                    rootDocId: 'root-owned',
                    name: 'My graph',
                    nameSource: 'device',
                    hasNameEnvelope: false,
                    onDevice: true,
                    role: 'owner',
                    members: null,
                    storage: { docBytes: 10, assetBytes: 20 },
                },
                {
                    id: 'shared',
                    rootDocId: 'root-shared',
                    name: 'Graph shared…',
                    nameSource: 'placeholder',
                    hasNameEnvelope: false,
                    onDevice: false,
                    role: 'player',
                    members: null,
                    storage: undefined,
                },
            ],
            ownedStorage: { graphs: 1, docBytes: 10, assetBytes: 20 },
        })
        expect(api.graphMembers).toHaveBeenCalledOnce()
        expect(api.graphMembers).toHaveBeenCalledWith('owned')
    })

    it('picks the rows an unlocked device should read a name for: not here, unlabelled, key held', () => {
        const view = (id: string, onDevice: boolean, nameSource: SyncedGraphView['nameSource']) =>
            ({ id, onDevice, nameSource, rootDocId: `${id}-root` }) as SyncedGraphView
        const views = [
            view('a', false, 'placeholder'),
            view('b', true, 'device'),
            view('c', false, 'envelope'),
            view('d', false, 'placeholder'),
        ]

        const picked = unlabelledGraphsToRead(views, [createGraphKeyring('a'), createGraphKeyring('c')])

        expect(picked.map((entry) => [entry.view.id, entry.keyring.graphId])).toEqual([['a', 'a']])
    })

    describe('the name envelope (ADR 0031, amended)', () => {
        const GRAPH = '018f47a0-7b5d-7cc5-b5c1-f0fbcde10000'

        async function overviewWith(nameEnvelope: string | null) {
            return {
                graphsOverview: vi.fn().mockResolvedValue({
                    graphs: [{ id: GRAPH, rootDocId: 'root', role: 'player', nameEnvelope }],
                    ownedStorage: { graphs: 0, docBytes: 0, assetBytes: 0 },
                }),
                graphMembers: vi.fn(),
            }
        }

        it('labels a graph this device never added from the envelope when the vault holds its key', async () => {
            const keyring = createGraphKeyring(GRAPH)
            const api = await overviewWith(toBase64Url(await sealGraphName(keyring, GRAPH, 'Physics Notes')))

            const { graphs } = await loadSyncedGraphViews(api, [], { keyrings: [keyring] })

            expect(graphs[0]).toMatchObject({ name: 'Physics Notes', nameSource: 'envelope', hasNameEnvelope: true, onDevice: false })
        })

        it('keeps the placeholder when the envelope cannot be read here', async () => {
            const keyring = createGraphKeyring(GRAPH)
            const api = await overviewWith(toBase64Url(await sealGraphName(keyring, GRAPH, 'Physics Notes')))

            const locked = await loadSyncedGraphViews(api, [])
            expect(locked.graphs[0]).toMatchObject({ name: `Graph ${GRAPH.slice(0, 8)}…`, nameSource: 'placeholder', hasNameEnvelope: true })

            const wrongKey = await loadSyncedGraphViews(api, [], { keyrings: [createGraphKeyring(GRAPH)] })
            expect(wrongKey.graphs[0]).toMatchObject({ nameSource: 'placeholder', hasNameEnvelope: true })
        })

        it('prefers the device record over the envelope for a graph on this device', async () => {
            const keyring = createGraphKeyring(GRAPH)
            const api = await overviewWith(toBase64Url(await sealGraphName(keyring, GRAPH, 'Renamed elsewhere')))
            const local = [
                { id: GRAPH, name: 'My graph', backend: 'server', createdAt: 42, handle: { rootDocId: 'root' } },
            ] as GraphRecord[]

            const { graphs } = await loadSyncedGraphViews(api, local, { keyrings: [keyring] })

            expect(graphs[0]).toMatchObject({ name: 'My graph', nameSource: 'device', hasNameEnvelope: true, onDevice: true })
        })

        it('reports a graph without an envelope so the page can backfill it from the device record', async () => {
            const api = await overviewWith(null)
            const local = [
                { id: GRAPH, name: 'My graph', backend: 'server', createdAt: 42, handle: { rootDocId: 'root' } },
            ] as GraphRecord[]

            const { graphs } = await loadSyncedGraphViews(api, local, { keyrings: [createGraphKeyring(GRAPH)] })

            expect(graphs[0]).toMatchObject({ name: 'My graph', nameSource: 'device', hasNameEnvelope: false })
        })
    })
})
