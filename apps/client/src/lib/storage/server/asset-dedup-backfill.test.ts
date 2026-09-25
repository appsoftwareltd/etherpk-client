import { describe, expect, it } from 'vitest'

import { assetDedupToken, contextAad, createGraphKeyring, currentEpoch, deriveAssetDedupSecret, sealSymmetric, toBase64Url, utf8 } from '$lib/crypto'
import { fixedSyncToken } from '$lib/sync/sync-token'

import { backfillAssetDedupTokens } from './asset-dedup-backfill'

const GRAPH = 'g-backfill'
const HASH_A = '1'.repeat(64)
const HASH_B = '2'.repeat(64)

/** The metadata blob a real upload wrote (see server-asset-store.ts), sealed under the epoch key. */
async function metadataFor(keyring: ReturnType<typeof createGraphKeyring>, assetId: string, hash: string) {
    const plaintext = utf8(JSON.stringify({ name: 'x.png', type: 'image/png', hash, isImage: true, perAssetKey: 'AAAA' }))
    const sealed = await sealSymmetric({
        key: currentEpoch(keyring).key,
        epochId: currentEpoch(keyring).epochId,
        plaintext,
        aad: contextAad('asset-meta', `graph:${GRAPH}`, `id:${assetId}`),
    })
    return toBase64Url(sealed)
}

/** A fetch stub for GET metadata + PATCH token; records the tokens it was sent. */
function stubApi(metadata: Record<string, string>, failPatchFor: string[] = []) {
    const patched: Record<string, string> = {}
    const gets: string[] = []
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input)
        const assetId = url.split('/').pop()!
        if (init?.method === 'PATCH') {
            if (failPatchFor.includes(assetId)) return new Response('{}', { status: 500 })
            patched[assetId] = (JSON.parse(init.body as string) as { dedupToken: string }).dedupToken
            return new Response(JSON.stringify({ ok: true }), { status: 200 })
        }
        gets.push(assetId)
        const blob = metadata[assetId]
        if (!blob) return new Response('{}', { status: 404 })
        return new Response(JSON.stringify({ encryptedMetadata: blob, size: 1, chunkCount: 1, status: 'complete', downloadUrls: [] }), {
            status: 200,
        })
    }) as typeof fetch
    return { f, patched, gets }
}

describe('backfillAssetDedupTokens (temporary, ADR 0053)', () => {
    it('tokens only the assets the list reports as untokened, with the same token a fresh upload would send', async () => {
        const keyring = createGraphKeyring(GRAPH)
        const { f, patched, gets } = stubApi({
            a: await metadataFor(keyring, 'a', HASH_A),
            b: await metadataFor(keyring, 'b', HASH_B),
        })
        const result = await backfillAssetDedupTokens(
            { graphId: GRAPH, baseUrl: 'http://server', syncToken: fixedSyncToken('t'), keyring, fetch: f },
            [
                { assetId: 'a', hasDedupToken: false, status: 'complete' },
                { assetId: 'b', hasDedupToken: true, status: 'complete' },
                { assetId: 'c', hasDedupToken: false, status: 'pending' },
            ],
        )
        expect(result).toEqual({ tokened: 1, failed: 0 })
        // Only `a` was fetched: `b` already has a token, `c` never finished uploading.
        expect(gets).toEqual(['a'])
        const secret = await deriveAssetDedupSecret(keyring)
        expect(patched).toEqual({ a: await assetDedupToken(secret, HASH_A) })
    })

    it('counts a failure and carries on, never throwing out of the orphan scan', async () => {
        const keyring = createGraphKeyring(GRAPH)
        const { f, patched } = stubApi({ a: await metadataFor(keyring, 'a', HASH_A), b: await metadataFor(keyring, 'b', HASH_B) }, ['a'])
        const result = await backfillAssetDedupTokens(
            { graphId: GRAPH, baseUrl: 'http://server', syncToken: fixedSyncToken('t'), keyring, fetch: f },
            [
                { assetId: 'a', hasDedupToken: false, status: 'complete' },
                { assetId: 'b', hasDedupToken: false, status: 'complete' },
                { assetId: 'missing', hasDedupToken: false, status: 'complete' },
            ],
        )
        expect(result).toEqual({ tokened: 1, failed: 2 })
        expect(Object.keys(patched)).toEqual(['b'])
    })

    it('does nothing when every asset is already tokened', async () => {
        const keyring = createGraphKeyring(GRAPH)
        const { f, gets } = stubApi({})
        const result = await backfillAssetDedupTokens(
            { graphId: GRAPH, baseUrl: 'http://server', syncToken: fixedSyncToken('t'), keyring, fetch: f },
            [{ assetId: 'a', hasDedupToken: true, status: 'complete' }],
        )
        expect(result).toEqual({ tokened: 0, failed: 0 })
        expect(gets).toEqual([])
    })
})
