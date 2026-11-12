import { describe, expect, it } from 'vitest'

import type { GraphRecord } from '#lib/storage/graph-registry.js'

import { type DeviceUploadDeps, sendQueuedUploadsOnThisDevice } from './queued-uploads-device'

const graph = (id: string, backend: GraphRecord['backend'] = 'server'): GraphRecord => ({
    id,
    name: id,
    backend,
    createdAt: 1,
    handle: {},
    ...(backend === 'server' ? { serverScope: { serverOrigin: 'https://sync.example', principalId: 'm1' } } : {}),
})

function deps(waiting: Record<string, number>, over: Partial<DeviceUploadDeps> = {}): DeviceUploadDeps & { asked: string[] } {
    const asked: string[] = []
    return {
        asked,
        copies: { queued: async (graphId: string) => Array.from({ length: waiting[graphId] ?? 0 }) as never },
        connection: () => ({ serverBaseUrl: 'https://sync.example', token: (async () => 't') as never }),
        send: async (graphId) => {
            asked.push(graphId)
            return { sent: waiting[graphId] ?? 0, waiting: 0 }
        },
        ...over,
    }
}

describe('sendQueuedUploadsOnThisDevice', () => {
    it('sends for each synced graph with uploads waiting, and asks nothing of the others', async () => {
        const d = deps({ a: 2, c: 1 })
        expect(await sendQueuedUploadsOnThisDevice([graph('a'), graph('b'), graph('c'), graph('folder', 'filesystem')], d)).toBe(3)
        expect(d.asked).toEqual(['a', 'c'])
    })

    it('leaves a graph with no connection on this device, and carries on past one that fails', async () => {
        const noConnection = deps({ a: 1 }, { connection: () => null })
        expect(await sendQueuedUploadsOnThisDevice([graph('a')], noConnection)).toBe(0)
        const failing = deps(
            { a: 1, b: 1 },
            {
                send: async (graphId) => {
                    if (graphId === 'a') throw new Error('the server is away')
                    return { sent: 1, waiting: 0 }
                },
            },
        )
        expect(await sendQueuedUploadsOnThisDevice([graph('a'), graph('b')], failing)).toBe(1)
    })
})
