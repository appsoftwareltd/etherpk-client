import { describe, expect, it, vi } from 'vitest'
import { bumpEpoch, createGraphKeyring, type GraphKeyring } from '#lib/crypto/index.js'
import type { VersionReason } from '@appsoftwareltd/etherpk-shared'
import { VersionApiError, VersionApiUnavailableError, type VersionApi } from './version-api'
import { memoryVersionOutbox } from './version-outbox'
import { openVersion } from './version-payload'
import { createVersionRecorder, type VersionSnapshot } from './version-recorder'

const GRAPH = '11111111-1111-4111-8111-111111111111'
const DOC = '22222222-2222-4222-8222-222222222222'
const MINUTE = 60_000

interface Held {
    docId: string
    versionId: string
    epochId: number
    reason: VersionReason
    envelope: Uint8Array
    createdAt: number
    verified: boolean
}

/**
 * A stand-in for the Sync Server's Version History routes with the rules the recorder meets:
 * idempotent ids, the current epoch, and listing only verified versions. `offline` makes every
 * call fail to connect.
 */
function serverApi(options: { now?: () => number; currentEpoch?: () => number } = {}) {
    const now = options.now ?? Date.now
    const held: Held[] = []
    const state = { offline: false }
    const online = () => {
        if (state.offline) throw new VersionApiUnavailableError('offline')
    }
    const api: VersionApi = {
        async upload(docId, v) {
            online()
            if (held.some((h) => h.versionId === v.versionId)) return 'exists'
            const epoch = options.currentEpoch?.() ?? 1
            if (v.epochId !== epoch) throw new VersionApiError('stale', 409, 'stale_epoch')
            held.push({ ...v, docId, envelope: v.envelope.slice(), createdAt: now(), verified: false })
            return 'stored'
        },
        async verify(_docId, versionId) {
            online()
            const version = held.find((h) => h.versionId === versionId)
            if (!version) throw new VersionApiError('missing', 404, 'version_missing')
            version.verified = true
        },
        async list(docId) {
            online()
            return {
                versions: held
                    .filter((h) => h.verified && h.docId === docId)
                    .map((h) => ({ versionId: h.versionId, createdAt: new Date(h.createdAt).toISOString(), reason: h.reason, bytes: h.envelope.byteLength, epochId: h.epochId })),
                policy: { retentionDays: 30, reduction: null, removalPaused: false },
            }
        },
        async get(_docId, versionId) {
            online()
            const version = held.find((h) => h.versionId === versionId)
            if (!version) throw new VersionApiError('missing', 404, 'version_missing')
            return {
                entry: { versionId, createdAt: new Date(version.createdAt).toISOString(), reason: version.reason, epochId: version.epochId },
                envelope: version.envelope.slice(),
            }
        },
        removeDocument: vi.fn(),
        deleted: vi.fn(),
        removeAll: vi.fn(),
        policy: vi.fn(),
        restoreAsset: vi.fn(),
        removeAssetForGood: vi.fn(),
        assetExists: vi.fn(),
    }
    return { api, held, state }
}

function snapshotOf(text: string): VersionSnapshot {
    return { text, identity: { kind: 'page', title: 'Garden', aliases: [] } }
}

/** A clock and timers a test moves by hand. */
function manualTime() {
    let now = Date.UTC(2026, 10, 11, 9, 0)
    const timers = new Map<number, { at: number; run: () => void }>()
    let next = 1
    return {
        now: () => now,
        setTimer: (run: () => void, ms: number) => {
            const id = next++
            timers.set(id, { at: now + ms, run })
            return id
        },
        clearTimer: (id: unknown) => void timers.delete(id as number),
        async advance(ms: number) {
            now += ms
            for (const [id, timer] of [...timers]) {
                if (timer.at <= now) {
                    timers.delete(id)
                    timer.run()
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 0))
        },
    }
}

describe('version recorder', () => {
    it('seals what the document held when asked, uploads it, reads it back and verifies it', async () => {
        const keyring = createGraphKeyring(GRAPH)
        const { api, held } = serverApi()
        let text = '- water the beans'
        const recorder = createVersionRecorder({ graphId: GRAPH, keyring, api, outbox: memoryVersionOutbox(), source: { read: () => snapshotOf(text) } })

        const recording = recorder.record(DOC, 'before_delete')
        // The operation the version is made for changes the text straight after asking.
        text = ''
        expect(await recording).toBe('queued')
        await recorder.flush()

        const listed = await api.list(DOC)
        expect(listed.versions).toHaveLength(1)
        expect(listed.versions[0].reason).toBe('before_delete')
        const { envelope } = await api.get(DOC, listed.versions[0].versionId)
        const opened = await openVersion({ keyring, graphId: GRAPH, docId: DOC, versionId: listed.versions[0].versionId, envelope })
        expect(opened.text).toBe('- water the beans')
        expect(held[0].verified).toBe(true)
    })

    it('keeps a version made with no network and sends it when the connection returns', async () => {
        const { api, state } = serverApi()
        state.offline = true
        const outbox = memoryVersionOutbox()
        const recorder = createVersionRecorder({ graphId: GRAPH, keyring: createGraphKeyring(GRAPH), api, outbox, source: { read: () => snapshotOf('- water the beans') } })
        await recorder.record(DOC, 'before_rename')
        await recorder.flush()
        expect(await outbox.list(GRAPH)).toHaveLength(1)

        state.offline = false
        await recorder.flush()
        expect(await outbox.list(GRAPH)).toEqual([])
        expect((await api.list(DOC)).versions).toHaveLength(1)
    })

    it('seals a waiting version again under the new epoch when the graph has moved on', async () => {
        let keyring: GraphKeyring = createGraphKeyring(GRAPH)
        let epoch = 1
        const { api, state } = serverApi({ currentEpoch: () => epoch })
        const outbox = memoryVersionOutbox()
        const recorder = createVersionRecorder({ graphId: GRAPH, keyring: () => keyring, api, outbox, source: { read: () => snapshotOf('- prune the roses') } })
        // Sealed under epoch 1 with no network; the graph moves to epoch 2 before it is sent.
        state.offline = true
        await recorder.record(DOC, 'before_delete')
        await recorder.flush()
        keyring = bumpEpoch(keyring)
        epoch = 2
        state.offline = false
        await recorder.flush()
        const listed = await api.list(DOC)
        expect(listed.versions.map((v) => v.epochId)).toEqual([2])
        expect(await outbox.list(GRAPH)).toEqual([])
    })

    it('drops a version the server refuses for good, and says so', async () => {
        const { api } = serverApi()
        const refused = { ...api, upload: async () => { throw new VersionApiError('refused', 403, 'quota_denied', 'entitlement_inactive') } }
        const onRefused = vi.fn()
        const outbox = memoryVersionOutbox()
        const recorder = createVersionRecorder({ graphId: GRAPH, keyring: createGraphKeyring(GRAPH), api: refused, outbox, source: { read: () => snapshotOf('x') }, onRefused })
        await recorder.record(DOC, 'before_delete')
        await recorder.flush()
        expect(await outbox.list(GRAPH)).toEqual([])
        expect(onRefused).toHaveBeenCalledOnce()
    })

    it('records nothing for a document it cannot read', async () => {
        const { api } = serverApi()
        const outbox = memoryVersionOutbox()
        const recorder = createVersionRecorder({ graphId: GRAPH, keyring: createGraphKeyring(GRAPH), api, outbox, source: { read: () => null } })
        expect(await recorder.record(DOC, 'before_delete')).toBe('unreadable')
        expect(await outbox.list(GRAPH)).toEqual([])
    })

    it('makes an idle version once edits stop, and no more often than every ten minutes', async () => {
        const time = manualTime()
        const { api } = serverApi({ now: time.now })
        let text = 'one'
        const recorder = createVersionRecorder({
            graphId: GRAPH,
            keyring: createGraphKeyring(GRAPH),
            api,
            outbox: memoryVersionOutbox(),
            source: { read: () => snapshotOf(text) },
            now: time.now,
            setTimer: time.setTimer,
            clearTimer: time.clearTimer,
            idleMs: 30_000,
        })
        const count = async () => (await api.list(DOC)).versions.length

        recorder.noteLocalEdit(DOC)
        await time.advance(20_000)
        recorder.noteLocalEdit(DOC)
        await time.advance(20_000)
        expect(await count()).toBe(0)
        await time.advance(15_000)
        await recorder.flush()
        expect(await count()).toBe(1)

        // Edits two minutes later wait out the ten minutes since that version.
        text = 'two'
        await time.advance(2 * MINUTE)
        recorder.noteLocalEdit(DOC)
        await time.advance(MINUTE)
        await recorder.flush()
        expect(await count()).toBe(1)
        await time.advance(8 * MINUTE)
        await recorder.flush()
        expect(await count()).toBe(2)

        // Nothing changed since: no version however long it waits.
        await time.advance(30 * MINUTE)
        await recorder.flush()
        expect(await count()).toBe(2)
        recorder.dispose()
    })

    it('keeps the edits not yet in a version when the document is closed or the page is left, without waiting out the ten minutes', async () => {
        const time = manualTime()
        const { api } = serverApi({ now: time.now })
        const texts = new Map([[DOC, 'one']])
        const OTHER = '33333333-3333-4333-8333-333333333333'
        const recorder = createVersionRecorder({
            graphId: GRAPH,
            keyring: createGraphKeyring(GRAPH),
            api,
            outbox: memoryVersionOutbox(),
            source: { read: (docId) => snapshotOf(texts.get(docId) ?? '') },
            now: time.now,
            setTimer: time.setTimer,
            clearTimer: time.clearTimer,
            idleMs: 30_000,
        })
        const count = async (docId: string) => (await api.list(docId)).versions.length
        recorder.noteLocalEdit(DOC)
        await time.advance(30_000)
        await recorder.flush()
        expect(await count(DOC)).toBe(1)

        // Edited two minutes later, then closed: kept at once, not ten minutes on.
        await time.advance(2 * MINUTE)
        texts.set(DOC, 'two')
        recorder.noteLocalEdit(DOC)
        recorder.settle(DOC)
        await recorder.flush()
        expect(await count(DOC)).toBe(2)
        // The idle timer it replaced makes no second copy of the same edits.
        await time.advance(15 * MINUTE)
        await recorder.flush()
        expect(await count(DOC)).toBe(2)

        // Closing a document with nothing new keeps nothing.
        recorder.settle(DOC)
        await recorder.flush()
        expect(await count(DOC)).toBe(2)

        // Leaving the page keeps every document with edits waiting.
        texts.set(DOC, 'three')
        texts.set(OTHER, 'other')
        recorder.noteLocalEdit(DOC)
        recorder.noteLocalEdit(OTHER)
        recorder.settle()
        await recorder.flush()
        expect([await count(DOC), await count(OTHER)]).toEqual([3, 1])
        recorder.dispose()
    })
})
