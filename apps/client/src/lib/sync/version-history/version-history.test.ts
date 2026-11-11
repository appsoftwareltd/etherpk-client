import { describe, expect, it, vi } from 'vitest'
import { createGraphKeyring } from '#lib/crypto/index.js'
import type { VersionApi } from './version-api'
import { assetIdsReferencedIn, createVersionHistory } from './version-history'
import { sealVersion, type DocumentVersionPayload } from './version-payload'
import type { VersionRecorder } from './version-recorder'

const GRAPH = '11111111-1111-4111-8111-111111111111'
const DOC = '22222222-2222-4222-8222-222222222222'
const VERSION = '33333333-3333-4333-8333-333333333333'
const IMAGE = '8b868cec-6f87-4fe2-8ee8-13f0f32722f4'
const GONE = '9c868cec-6f87-4fe2-8ee8-13f0f32722f5'

describe('assetIdsReferencedIn', () => {
    it('finds each asset a synced document references, once, and nothing else', () => {
        const text = [
            `- ![Beans|300](../assets/beans.${IMAGE}.webp)`,
            `- [Seed list](../assets/seed-list.${GONE}.pdf) and again ![](../assets/beans.${IMAGE}.webp)`,
            '- [[Garden]] is not a file, and neither is 44444444-4444-4444-8444-444444444444 written in prose',
        ].join('\n')
        expect(assetIdsReferencedIn(text).sort()).toEqual([IMAGE, GONE].sort())
    })
})

describe('version history', () => {
    async function setup(payload: DocumentVersionPayload) {
        const keyring = createGraphKeyring(GRAPH)
        const sealed = await sealVersion({ keyring, graphId: GRAPH, docId: DOC, versionId: VERSION, payload })
        const restoreAsset = vi.fn(async (assetId: string) => (assetId === GONE ? ('gone' as const) : ('restored' as const)))
        const api = {
            policy: vi.fn(async () => ({ retentionDays: 30, reduction: null, removalPaused: false })),
            get: vi.fn(async () => ({ entry: { versionId: VERSION, createdAt: '', reason: 'idle' as const, epochId: 1 }, envelope: sealed.envelope })),
            restoreAsset,
            removeDocument: vi.fn(async () => 1),
            deleted: vi.fn(async () => ({
                documents: [{ docId: DOC, deletedAt: null, newestVersionId: VERSION, newestVersionAt: '2026-11-11T09:00:00.000Z', removeAt: '2026-12-11T09:00:00.000Z' }],
                assets: [{ assetId: IMAGE, size: 10, deletedAt: '2026-11-11T09:00:00.000Z', removeAt: null }],
                policy: { retentionDays: 30, reduction: null, removalPaused: false },
            })),
        } as unknown as VersionApi
        const recorder = { flush: vi.fn(async () => {}), forget: vi.fn(async () => {}), settle: vi.fn() } as unknown as VersionRecorder
        const restoreVersion = vi.fn(async () => ({ kind: 'restored' as const, concept: 'Garden' }))
        const history = createVersionHistory({
            graphId: GRAPH,
            keyring,
            api,
            recorder,
            store: { restoreVersion, documentIdOf: () => DOC },
            assetName: async (id) => (id === IMAGE ? 'beans.webp' : null),
        })
        return { history, api, recorder, restoreVersion, restoreAsset }
    }

    const payload: DocumentVersionPayload = {
        v: 1,
        identity: { kind: 'page', title: 'Garden', aliases: [] },
        text: `- ![Beans](../assets/beans.${IMAGE}.webp)\n- ![Seeds](../assets/seeds.${GONE}.webp)`,
    }

    it('restores the version’s text and brings back the files it references, naming those gone for good', async () => {
        const { history, restoreVersion, restoreAsset } = await setup(payload)
        const outcome = await history.restore(DOC, VERSION)
        expect(restoreVersion).toHaveBeenCalledWith(DOC, { text: payload.text, identity: payload.identity }, undefined)
        expect(restoreAsset).toHaveBeenCalledTimes(2)
        expect(outcome).toEqual({ kind: 'restored', concept: 'Garden', missingAssets: [GONE] })
    })

    it('writes nothing while the graph owner’s plan is inactive', async () => {
        const { history, api, restoreVersion } = await setup(payload)
        vi.mocked(api.policy).mockResolvedValueOnce({ retentionDays: 30, reduction: null, removalPaused: true })
        expect(await history.restore(DOC, VERSION)).toEqual({ kind: 'read-only' })
        expect(restoreVersion).not.toHaveBeenCalled()
    })

    it('restores no files when the text was not restored', async () => {
        const { history, restoreVersion, restoreAsset } = await setup(payload)
        restoreVersion.mockResolvedValueOnce({ kind: 'name-taken', name: 'Garden' } as never)
        expect(await history.restore(DOC, VERSION)).toEqual({ kind: 'name-taken', name: 'Garden' })
        expect(restoreAsset).not.toHaveBeenCalled()
    })

    it('names each Deleted Document from its newest version, and each Deleted Asset from its metadata', async () => {
        const { history } = await setup(payload)
        const listing = await history.deleted()
        expect(listing.documents[0].identity).toEqual(payload.identity)
        expect(listing.assets[0].name).toBe('beans.webp')
    })

    it('removes a protected document’s history, with anything still waiting to be sent', async () => {
        const { history, recorder, api } = await setup(payload)
        await history.documentProtected(DOC)
        expect(recorder.forget).toHaveBeenCalledWith(DOC)
        expect(api.removeDocument).toHaveBeenCalledWith(DOC)
    })

    it('keeps a closed document’s waiting edits by its id, and every document’s when the page is left', async () => {
        const { history, recorder } = await setup(payload)
        history.settle('Garden')
        expect(recorder.settle).toHaveBeenLastCalledWith(DOC)
        history.settle()
        expect(recorder.settle).toHaveBeenLastCalledWith()
    })
})
