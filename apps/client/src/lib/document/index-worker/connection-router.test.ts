import { describe, expect, it, vi } from 'vitest'

import type { IndexDoc, SqlDb } from '../index-db'
import { openInMemorySqlDb } from '../index-db-sqlite'
import { createIndexCore, type IndexCore, type IndexDbHost } from './core'
import { createConnectionRouter, type IndexConnection } from './connection-router'
import type { IndexResponse } from './protocol'

/**
 * The multi-tab routing of ADR 0042: one core, several connections. What these protect:
 * every tab sees the shared snapshot, answers go only to who asked, and a closing tab
 * cannot take the index down with it.
 */

const doc = (concept: string, text: string): IndexDoc => ({ concept, kind: 'page', aliases: [], text })

function connection(): IndexConnection & { received: IndexResponse[] } {
    const received: IndexResponse[] = []
    return { received, post: (response) => received.push(response) }
}

function countingHost() {
    const dbs = new Map<string, SqlDb>()
    let opens = 0
    const host: IndexDbHost = {
        async open(graphId) {
            opens += 1
            let db = dbs.get(graphId)
            if (!db) {
                db = await openInMemorySqlDb()
                dbs.set(graphId, db)
            }
            return { db, persisted: true }
        },
        async discard(graphId) {
            const db = await openInMemorySqlDb()
            dbs.set(graphId, db)
            return { db, persisted: true }
        },
    }
    return { host, opens: () => opens }
}

async function rebuild(router: ReturnType<typeof createConnectionRouter>, from: IndexConnection, docs: IndexDoc[]) {
    const rebuildId = crypto.randomUUID()
    await router.handle(from, { type: 'rebuild-begin', rebuildId, total: docs.length })
    await router.handle(from, { type: 'rebuild-docs', rebuildId, docs })
    await router.handle(from, { type: 'rebuild-commit', rebuildId })
}

describe('connection router', () => {
    it('broadcasts snapshots to every tab but answers only the asker', async () => {
        const { host } = countingHost()
        const router = createConnectionRouter(createIndexCore(host))
        const owner = connection()
        const second = connection()
        router.attach(owner)
        router.attach(second)

        await router.handle(owner, { type: 'open', graphId: 'g1' }, { owner: true })
        await rebuild(router, owner, [doc('Alpha', '- [[Beta]]')])

        // The rebuild's snapshot reached BOTH tabs; the 'opened' only the owner.
        expect(second.received.some((r) => r.type === 'snapshot')).toBe(true)
        expect(second.received.some((r) => r.type === 'opened')).toBe(false)

        const before = second.received.length
        await router.handle(owner, { type: 'backlinks', id: 1, concept: 'Beta' })
        expect(owner.received.some((r) => r.type === 'backlinks' && r.id === 1)).toBe(true)
        expect(second.received.length).toBe(before) // nothing new for the bystander
    })

    it('a second tab opening the same graph reuses the live database', async () => {
        const { host, opens } = countingHost()
        const router = createConnectionRouter(createIndexCore(host))
        const owner = connection()
        const second = connection()
        router.attach(owner)
        router.attach(second)

        await router.handle(owner, { type: 'open', graphId: 'g1' }, { owner: true })
        await rebuild(router, owner, [doc('Alpha', '- a')])
        await router.handle(second, { type: 'open', graphId: 'g1' })

        expect(opens()).toBe(1) // never re-opened the file
        const opened = second.received.find((r) => r.type === 'opened')
        expect(opened).toMatchObject({ type: 'opened', persisted: true, indexedDocuments: 1 })
    })

    it('returns open and recovery snapshots only to the tab which requested them', async () => {
        const { host } = countingHost()
        const router = createConnectionRouter(createIndexCore(host))
        const owner = connection()
        const second = connection()
        router.attach(owner)
        router.attach(second)

        await router.handle(owner, { type: 'open', graphId: 'g1' }, { owner: true })
        await rebuild(router, owner, [doc('Alpha', '- a')])

        owner.received.length = 0
        second.received.length = 0
        await router.handle(second, { type: 'open', graphId: 'g1' })
        expect(second.received.some((response) => response.type === 'snapshot')).toBe(true)
        expect(owner.received.some((response) => response.type === 'snapshot')).toBe(false)

        owner.received.length = 0
        second.received.length = 0
        await router.handle(second, { type: 'snapshot-request' })
        expect(second.received.some((response) => response.type === 'snapshot')).toBe(true)
        expect(owner.received.some((response) => response.type === 'snapshot')).toBe(false)
    })

    it('serializes simultaneous opens from newly attached tabs', async () => {
        let releaseOpen!: () => void
        const gate = new Promise<void>((resolve) => {
            releaseOpen = resolve
        })
        let opens = 0
        const host: IndexDbHost = {
            async open() {
                opens += 1
                await gate
                return { db: await openInMemorySqlDb(), persisted: true }
            },
            async discard() {
                return { db: await openInMemorySqlDb(), persisted: true }
            },
        }
        const router = createConnectionRouter(createIndexCore(host))
        const owner = connection()
        const second = connection()
        router.attach(owner)
        router.attach(second)

        // Message events from separate ports are independent. Both requests can arrive
        // while sqlite-wasm and OPFS are still opening, but only one may enter the core.
        const firstOpen = router.handle(
            owner,
            { type: 'open', graphId: 'g1', openId: 1 },
            { owner: true },
        )
        const secondOpen = router.handle(second, { type: 'open', graphId: 'g1', openId: 2 })

        // Admission and completion are separate. First-time OPFS setup can legitimately
        // outlive the tab's startup patience, so both accepted opens are acknowledged at
        // the queue boundary. The worker owns the terminal safety bound after admission.
        expect(owner.received).toContainEqual({ type: 'open-accepted', openId: 1 })
        expect(second.received).toContainEqual({ type: 'open-accepted', openId: 2 })
        expect(second.received.some((response) => response.type === 'opened')).toBe(false)
        releaseOpen()
        await Promise.all([firstOpen, secondOpen])

        expect(opens).toBe(1)
        expect(owner.received.some((response) => response.type === 'opened')).toBe(true)
        expect(second.received.some((response) => response.type === 'opened')).toBe(true)
    })

    it('admits an attached tab before already-queued background ingests', async () => {
        // Catch-up can enqueue a long run of ordinary ingests. A newly attached tab's open
        // is idempotent and cheap, so after the CURRENT SQLite turn finishes it must not sit
        // behind every background turn which happened to arrive first.
        let releaseActive!: () => void
        const activeGate = new Promise<void>((resolve) => {
            releaseActive = resolve
        })
        let markActive!: () => void
        const active = new Promise<void>((resolve) => {
            markActive = resolve
        })
        const order: string[] = []
        let ingest = 0
        const core: IndexCore = {
            async handle(request) {
                if (request.type === 'ingest') {
                    ingest += 1
                    order.push(`ingest-${ingest}`)
                    if (ingest === 1) {
                        markActive()
                        await activeGate
                    }
                } else {
                    order.push(request.type)
                }
                return []
            },
            dispose() {},
        }
        const router = createConnectionRouter(core)
        const owner = connection()
        const follower = connection()
        router.attach(owner)
        router.attach(follower)

        const activeIngest = router.handle(owner, { type: 'ingest', docs: [] })
        await active
        const queuedIngest = router.handle(owner, { type: 'ingest', docs: [] })
        const followerOpen = router.handle(follower, { type: 'open', graphId: 'g1', openId: 7 })
        expect(follower.received).toContainEqual({ type: 'open-accepted', openId: 7 })
        releaseActive()
        await Promise.all([activeIngest, queuedIngest, followerOpen])

        expect(order).toEqual(['ingest-1', 'open', 'ingest-2'])
    })

    it('returns to the worker event loop between queued background turns', async () => {
        // A ferried port cannot enqueue its priority open until the worker handles the bridge
        // message which adopts it. Draining an already-populated ordinary queue entirely from
        // promise microtasks starves that message, so the open lane never gets a chance to win.
        const order: string[] = []
        let ingest = 0
        const core: IndexCore = {
            async handle(request) {
                if (request.type === 'ingest') {
                    ingest += 1
                    order.push(`ingest-${ingest}`)
                } else {
                    order.push(request.type)
                }
                return []
            },
            dispose() {},
        }
        const router = createConnectionRouter(core)
        const owner = connection()
        const follower = connection()
        router.attach(owner)
        router.attach(follower)

        const first = router.handle(owner, { type: 'ingest', docs: [] })
        const second = router.handle(owner, { type: 'ingest', docs: [] })
        const adoption = new MessageChannel()
        const adoptedOpen = new Promise<void>((resolve, reject) => {
            adoption.port1.onmessage = () => {
                void router
                    .handle(follower, { type: 'open', graphId: 'g1', openId: 8 })
                    .then(resolve, reject)
            }
            adoption.port1.start()
            adoption.port2.postMessage(undefined)
        })

        await Promise.all([first, second, adoptedOpen])
        adoption.port1.close()
        adoption.port2.close()
        expect(order.indexOf('open')).toBeLessThan(order.indexOf('ingest-2'))
        expect(order.filter((entry) => entry.startsWith('ingest'))).toEqual([
            'ingest-1',
            'ingest-2',
        ])
    })

    it('reports a terminal failure when an accepted open never completes', async () => {
        vi.useFakeTimers()
        try {
            const never = new Promise<IndexResponse[]>(() => {})
            const core: IndexCore = {
                handle: () => never,
                dispose() {},
            }
            const router = createConnectionRouter(core, { openTerminalTimeoutMs: 50 })
            const tab = connection()
            router.attach(tab)

            const handled = router.handle(tab, { type: 'open', graphId: 'g1', openId: 9 })
            expect(tab.received).toContainEqual({ type: 'open-accepted', openId: 9 })

            await vi.advanceTimersByTimeAsync(50)
            await handled
            expect(tab.received).toContainEqual({
                type: 'error',
                openId: 9,
                message: 'the index worker did not complete the accepted open',
            })
        } finally {
            vi.useRealTimers()
        }
    })

    it('settles an expired open even when its connection can no longer receive the error', async () => {
        vi.useFakeTimers()
        try {
            const core: IndexCore = {
                handle: () => new Promise<IndexResponse[]>(() => {}),
                dispose() {},
            }
            const router = createConnectionRouter(core, { openTerminalTimeoutMs: 50 })
            const closedConnection: IndexConnection = {
                post(response) {
                    if (response.type === 'error') throw new Error('port is closed')
                },
            }
            router.attach(closedConnection)

            const handled = router.handle(closedConnection, {
                type: 'open',
                graphId: 'g1',
                openId: 10,
            })
            await vi.advanceTimersByTimeAsync(50)

            await expect(handled).resolves.toBeUndefined()
        } finally {
            vi.useRealTimers()
        }
    })

    it('broadcasts the same ordered delta revision to every attached tab', async () => {
        const { host } = countingHost()
        const router = createConnectionRouter(createIndexCore(host))
        const owner = connection()
        const second = connection()
        router.attach(owner)
        router.attach(second)
        await router.handle(owner, { type: 'open', graphId: 'g1' }, { owner: true })
        await rebuild(router, owner, [doc('Alpha', '- [[Before]]')])

        await router.handle(owner, {
            type: 'ingest',
            docs: [doc('Alpha', '- [[After]]')],
        })

        const ownerDelta = owner.received.findLast((response) => response.type === 'delta')
        const secondDelta = second.received.findLast((response) => response.type === 'delta')
        expect(ownerDelta).toMatchObject({ type: 'delta', revision: 2 })
        expect(secondDelta).toEqual(ownerDelta)
    })

    it('a closing tab detaches without touching the shared database', async () => {
        const { host } = countingHost()
        const router = createConnectionRouter(createIndexCore(host))
        const owner = connection()
        const second = connection()
        router.attach(owner)
        router.attach(second)
        await router.handle(owner, { type: 'open', graphId: 'g1' }, { owner: true })
        await rebuild(router, owner, [doc('Alpha', '- see [[Beta]]')])

        await router.handle(second, { type: 'close' })

        // The survivor still gets answers, and the departed tab gets no more snapshots.
        const before = second.received.length
        await rebuild(router, owner, [doc('Alpha', '- now [[Gamma]]')])
        expect(second.received.length).toBe(before)
        await router.handle(owner, { type: 'backlinks', id: 2, concept: 'Gamma' })
        const backlinks = owner.received.find((r) => r.type === 'backlinks' && r.id === 2)
        expect(backlinks && backlinks.type === 'backlinks' && backlinks.groups.length).toBe(1)
    })

    it('routes a failure back to the asker with its request id', async () => {
        const { host } = countingHost()
        const router = createConnectionRouter(createIndexCore(host))
        const tab = connection()
        router.attach(tab)

        // rebuild-docs without begin: a protocol violation the core rejects.
        await router.handle(tab, {
            type: 'rebuild-docs',
            rebuildId: 'not-started',
            docs: [],
        })
        expect(tab.received.some((r) => r.type === 'error')).toBe(true)
    })
})
