import { describe, expect, it, vi } from 'vitest'

import type { AssetBytes } from '$lib/storage/fs/asset-store'

import { createMirrorSource } from './mirror-source'
import type { DocumentIdentity, DocumentText, ServerDocumentStore } from './server-document-store'

/**
 * The glue between the mirror and the live graph. Thin, but every line of it is a place the
 * mirror can be quietly wrong about what the graph holds, so each one is pinned.
 */
const ID = '11111111-1111-4111-8111-111111111111'

function fakeStore(overrides: Partial<ServerDocumentStore> = {}): ServerDocumentStore {
    const identities: DocumentIdentity[] = [{ docId: 'd1', kind: 'page', concept: 'Doc', aliases: [] }]
    const listeners = new Set<(change?: { concept: string }) => void>()
    const store: Partial<ServerDocumentStore> = {
        listIdentities: () => identities,
        readTexts: async (docIds, options) => {
            const out = new Map<string, DocumentText>()
            for (const docId of docIds) out.set(docId, { text: 'body', settled: true })
            options?.onProgress?.(out.size, docIds.length)
            return out
        },
        confirmRegistry: async () => true,
        onChange: (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        ...overrides,
    }
    return store as ServerDocumentStore
}

function fakeAssets(byRef: Record<string, AssetBytes | null>) {
    const asked: string[] = []
    return {
        asked,
        readBytes: async (ref: string) => {
            asked.push(ref)
            return byRef[ref] ?? null
        },
    }
}

describe('createMirrorSource', () => {
    it('lists documents by id and passes read progress through', async () => {
        const src = createMirrorSource({ store: fakeStore() })
        expect(src.listDocuments()).toEqual([{ docId: 'd1', kind: 'page', concept: 'Doc', aliases: [] }])
        const progress = vi.fn()
        const texts = await src.readTexts(['d1'], progress)
        expect(texts.get('d1')).toEqual({ text: 'body', settled: true })
        expect(progress).toHaveBeenCalledWith(1, 1)
    })

    it('offers no asset surface without both an asset store and a listing', () => {
        expect(createMirrorSource({ store: fakeStore() }).listGraphAssets).toBeUndefined()
        expect(createMirrorSource({ store: fakeStore(), assets: fakeAssets({}) }).listGraphAssets).toBeUndefined()
        expect(
            createMirrorSource({ store: fakeStore(), listAssetIds: async () => [] }).listGraphAssets,
        ).toBeUndefined()
    })

    it('answers null, not a list, when the graph cannot be asked', async () => {
        const src = createMirrorSource({
            store: fakeStore(),
            assets: fakeAssets({}),
            listAssetIds: async () => {
                throw new Error('offline')
            },
        })
        // The mirror deletes against this list; a failed fetch must read as "unknown".
        expect(await src.listGraphAssets!()).toBeNull()
    })

    it('identifies an asset from its file name, and only a real one', () => {
        const src = createMirrorSource({ store: fakeStore(), assets: fakeAssets({}), listAssetIds: async () => [] })
        expect(src.assetIdOf!(`photo.${ID}.png`)).toBe(ID)
        expect(src.assetIdOf!('old-import.a1b2c3d4.png')).toBeNull()
    })

    it('fetches by id and names an unreferenced asset the way an upload would', async () => {
        const assets = fakeAssets({
            [`../assets/${ID}`]: { bytes: new Uint8Array([1, 2]), name: 'Q3 Report.PDF', type: 'application/pdf' },
        })
        const src = createMirrorSource({ store: fakeStore(), assets, listAssetIds: async () => [ID] })
        const result = await src.fetchAsset!(ID)
        expect(result).toEqual({ bytes: new Uint8Array([1, 2]), fileName: `q3-report.${ID}.pdf` })
        expect(assets.asked).toEqual([`../assets/${ID}`])
        // An asset the store cannot produce right now is unavailable, not a file with no bytes.
        expect(await src.fetchAsset!('22222222-2222-4222-8222-222222222222')).toBe('unavailable')
    })

    it('reports a metadata change as an unnamed change, so the folder metadata is rewritten', () => {
        let metaListener: (() => void) | undefined
        const src = createMirrorSource({
            store: fakeStore(),
            onMetadataChange: (listener) => {
                metaListener = listener
                return () => (metaListener = undefined)
            },
        })
        const seen: Array<{ concept: string } | undefined> = []
        const detach = src.onChange((change) => seen.push(change))
        metaListener?.()
        expect(seen).toEqual([undefined])
        detach()
        expect(metaListener).toBeUndefined()
    })
})
