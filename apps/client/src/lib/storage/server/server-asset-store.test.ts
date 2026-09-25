import { describe, expect, it, vi } from 'vitest'
import { createGraphKeyring } from '$lib/crypto'
import { fixedSyncToken } from '$lib/sync/sync-token'
import { assetIdFromRef, createServerAssetStore } from './server-asset-store'

/**
 * A fake sync-asset backend: the REST endpoints + presigned S3 URLs, all in memory. It stores
 * exactly what a real server/bucket would — ciphertext only — so the test also proves the
 * server never sees plaintext (ADR 0027).
 */
function fakeBackend() {
    const objects = new Map<string, Uint8Array>() // presigned-URL → bytes
    const assets = new Map<string, { encryptedMetadata: string; chunkCount: number; dedupToken?: string; status: string }>()
    let urlSeq = 0
    /** Every begin call's body, so a test can assert what the client sent (ADR 0053 token). */
    const begins: Array<{ assetId: string; dedupToken?: string }> = []

    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString()
        const json = (body: unknown, status = 200) =>
            new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

        // Presigned object URL (our fake scheme).
        if (url.startsWith('mem://obj/')) {
            if (init?.method === 'PUT') {
                objects.set(url, new Uint8Array(init.body as ArrayBuffer))
                return new Response(null, { status: 200 })
            }
            const bytes = objects.get(url)
            return bytes ? new Response(bytes as BodyInit) : new Response(null, { status: 404 })
        }
        // POST /assets — begin upload.
        if (url.endsWith('/api/v1/sync/assets') && init?.method === 'POST') {
            const body = JSON.parse(init.body as string) as {
                assetId: string
                chunkCount: number
                encryptedMetadata: string
                dedupToken?: string
            }
            begins.push({ assetId: body.assetId, dedupToken: body.dedupToken })
            // Within-graph reuse (ADR 0053): a COMPLETE asset already carrying this token is
            // handed back instead of presigned URLs; a pending one never matches.
            if (body.dedupToken) {
                for (const [assetId, asset] of assets) {
                    if (asset.dedupToken === body.dedupToken && asset.status === 'complete') return json({ reuse: { assetId } })
                }
            }
            assets.set(body.assetId, {
                encryptedMetadata: body.encryptedMetadata,
                chunkCount: body.chunkCount,
                dedupToken: body.dedupToken,
                status: 'pending',
            })
            return json({ uploadUrls: Array.from({ length: body.chunkCount }, () => `mem://obj/${body.assetId}/${++urlSeq}`) })
        }
        // GET /assets/:graph/:asset — metadata + download urls.
        const getMatch = /\/api\/v1\/sync\/assets\/[^/]+\/([^/]+)$/.exec(url)
        if (getMatch && (!init || init.method === undefined || init.method === 'GET')) {
            const asset = assets.get(getMatch[1])
            if (!asset) return new Response(null, { status: 404 })
            // Return the SAME object urls that were PUT (in order).
            const keys = [...objects.keys()].filter((k) => k.includes(`/${getMatch[1]}/`)).sort()
            return json({ encryptedMetadata: asset.encryptedMetadata, size: 0, chunkCount: asset.chunkCount, status: 'complete', downloadUrls: keys })
        }
        // POST complete.
        if (getMatch && init?.method === 'POST') {
            const asset = assets.get(getMatch[1])
            if (asset) asset.status = 'complete'
            return json({ ok: true })
        }
        return new Response(null, { status: 404 })
    }) as unknown as typeof fetch

    return { fetchImpl, objects, assets, begins }
}

describe('ServerAssetStore', () => {
    it('encrypts, uploads, and round-trips an asset; the backend holds only ciphertext', async () => {
        const { fetchImpl, objects } = fakeBackend()
        const keyring = createGraphKeyring('g1')
        let id = 0
        const store = createServerAssetStore({
            graphId: 'g1',
            keyring,
            baseUrl: 'https://sync.example',
            syncToken: fixedSyncToken('sync-tok'),
            fetch: fetchImpl,
            newAssetId: () => `00000000-0000-4000-8000-00000000000${++id}`,
        })

        const plaintext = new TextEncoder().encode('SECRET-IMAGE-BYTES-'.repeat(100))
        const saved = await store.save({ name: 'My Diagram.png', bytes: plaintext as Uint8Array<ArrayBuffer>, type: 'image/png' })
        expect(saved.ref).toMatch(/^\.\.\/assets\/my-diagram\.[0-9a-f-]+\.png$/)
        expect(saved.isImage).toBe(true)

        // The bucket holds only ciphertext — the plaintext never appears in any stored object.
        for (const bytes of objects.values()) {
            expect(new TextDecoder('latin1').decode(bytes)).not.toContain('SECRET-IMAGE-BYTES')
        }

        // Round-trip: resolve downloads + decrypts back to a blob URL (createObjectURL stubbed).
        const created: Blob[] = []
        vi.stubGlobal('URL', { createObjectURL: (b: Blob) => { created.push(b); return 'blob:mem/1' }, revokeObjectURL: () => {} })
        const objUrl = (await store.resolve(saved.ref))?.url
        expect(objUrl).toBe('blob:mem/1')
        expect(created).toHaveLength(1)
        expect(await created[0].text()).toBe(new TextDecoder().decode(plaintext))
        vi.unstubAllGlobals()
    })

    it('types a downloaded asset by its extension, never by the type its uploader declared', async () => {
        // The declared type is whatever a collaborator's client sent. Typed text/html, a blob
        // opened in its own tab would be a same-origin HTML document.
        const { fetchImpl } = fakeBackend()
        let id = 0
        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://sync.example',
            syncToken: fixedSyncToken('sync-tok'),
            fetch: fetchImpl,
            newAssetId: () => `00000000-0000-4000-8000-00000000000${++id}`,
        })
        const bytes = new TextEncoder().encode('<script>alert(1)</script>') as Uint8Array<ArrayBuffer>
        const page = await store.save({ name: 'page.html', bytes, type: 'text/html' })
        const disguised = await store.save({ name: 'photo.png', bytes, type: 'text/html' })
        const created: Blob[] = []
        vi.stubGlobal('URL', { createObjectURL: (b: Blob) => { created.push(b); return 'blob:mem/1' }, revokeObjectURL: () => {} })
        expect((await store.resolve(page.ref))?.type).toBe('application/octet-stream')
        expect((await store.resolve(disguised.ref))?.type).toBe('image/png')
        expect(created.map((b) => b.type)).toEqual(['application/octet-stream', 'image/png'])
        expect((await store.readBytes(page.ref))?.type).toBe('application/octet-stream')
        vi.unstubAllGlobals()
    })

    it('names the bucket CORS policy when a presigned chunk PUT dies as a network error', async () => {
        // The browser reports a CORS-blocked presigned PUT as a bare TypeError('Failed to
        // fetch') - the single live failure mode that burned real debugging time. The store
        // must translate it into something a user/operator can act on.
        const { fetchImpl } = fakeBackend()
        let puts = 0
        const failingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString()
            if (url.startsWith('mem://obj/') && init?.method === 'PUT') {
                puts += 1
                throw new TypeError('Failed to fetch')
            }
            return fetchImpl(input, init)
        }) as typeof fetch
        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://sync.example',
            syncToken: fixedSyncToken('sync-tok'),
            fetch: failingFetch,
            newAssetId: () => '00000000-0000-4000-8000-000000000001',
            retry: { attempts: 4, sleep: async () => {} },
        })
        await expect(
            store.save({ name: 'pic.png', bytes: new Uint8Array(16) as Uint8Array<ArrayBuffer>, type: 'image/png' }),
        ).rejects.toThrow(/CORS policy/)
        // A dropped connection looks identical to a CORS refusal in the browser, so this is
        // retried first and only named once the attempts run out - seconds, not hours.
        expect(puts).toBe(4)
    })

    it('presents a freshly sourced token on every request, not one captured at construction', async () => {
        // The live failure this pins: an import held the token minted at its start, uploaded
        // for exactly fifteen minutes, and then every `begin` call 401'd.
        const { fetchImpl } = fakeBackend()
        const sent: string[] = []
        const recordingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const token = (init?.headers as Record<string, string> | undefined)?.['x-sync-token']
            if (token) sent.push(token)
            return fetchImpl(input, init)
        }) as typeof fetch

        let minted = 0
        let id = 0
        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://sync.example',
            syncToken: async () => `tok-${++minted}`,
            fetch: recordingFetch,
            newAssetId: () => `00000000-0000-4000-8000-00000000000${++id}`,
        })

        // Two DIFFERENT payloads: identical bytes would be reused on the second save (ADR
        // 0053), which is one request fewer and not what this test is measuring.
        const first = await store.save({ name: 'a.png', bytes: new Uint8Array(8) as Uint8Array<ArrayBuffer>, type: 'image/png' })
        await store.save({ name: 'b.png', bytes: new Uint8Array(8).fill(1) as Uint8Array<ArrayBuffer>, type: 'image/png' })
        await store.resolve(first.ref)

        // begin + complete for each save, then the resolve: every one asked afresh.
        expect(sent).toEqual(['tok-1', 'tok-2', 'tok-3', 'tok-4', 'tok-5'])
    })

    it('rides out a transient failure on begin, a chunk PUT, and complete', async () => {
        // The whole point of the retry: ONE bad request used to unwind an entire import
        // (mapWithPool rejects on first error, runServerImport then deletes the graph).
        const { fetchImpl, objects } = fakeBackend()
        const failures = new Map<string, number>([
            ['begin', 1],
            ['put', 1],
            ['complete', 1],
        ])
        const flakyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString()
            const kind = url.startsWith('mem://obj/')
                ? 'put'
                : url.endsWith('/api/v1/sync/assets')
                  ? 'begin'
                  : init?.method === 'POST'
                    ? 'complete'
                    : 'other'
            const left = failures.get(kind) ?? 0
            if (left > 0) {
                failures.set(kind, left - 1)
                return new Response(null, { status: 503 })
            }
            return fetchImpl(input, init)
        }) as typeof fetch

        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://sync.example',
            syncToken: fixedSyncToken('t'),
            fetch: flakyFetch,
            newAssetId: () => '00000000-0000-4000-8000-000000000001',
            retry: { sleep: async () => {} },
        })

        const bytes = new TextEncoder().encode('hello') as Uint8Array<ArrayBuffer>
        const saved = await store.save({ name: 'pic.png', bytes, type: 'image/png' })
        expect(saved.ref).toContain('00000000-0000-4000-8000-000000000001')
        expect(objects.size).toBe(1) // the chunk really landed, on its second try
        expect([...failures.values()]).toEqual([0, 0, 0])
    })

    it('forces a fresh token when the server rejects the one it was given', async () => {
        // Clock skew: the source still believes its token is live, the server has retired it.
        // Presenting the same one again would fail identically, so a 401 must re-mint.
        const { fetchImpl } = fakeBackend()
        const seen: string[] = []
        let minted = 0
        const authFetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const token = (init?.headers as Record<string, string> | undefined)?.['x-sync-token']
            if (token) {
                seen.push(token)
                if (token === 'tok-1') return new Response(null, { status: 401 })
            }
            return fetchImpl(input, init)
        }) as typeof fetch

        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://sync.example',
            syncToken: async (opts) => (opts?.force ? `tok-${++minted}` : `tok-${minted || ++minted}`),
            fetch: authFetch,
            newAssetId: () => '00000000-0000-4000-8000-000000000001',
            retry: { sleep: async () => {} },
        })

        const bytes = new TextEncoder().encode('hi') as Uint8Array<ArrayBuffer>
        await expect(store.save({ name: 'pic.png', bytes, type: 'image/png' })).resolves.toBeTruthy()
        expect(seen[0]).toBe('tok-1')
        expect(seen[1]).toBe('tok-2') // the retry did not present the dead token again
    })

    it('does not retry a failure that will never come good, and names the asset', async () => {
        const { fetchImpl } = fakeBackend()
        let begins = 0
        const rejectingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString()
            if (url.endsWith('/api/v1/sync/assets') && init?.method === 'POST') {
                begins += 1
                return new Response(null, { status: 400 })
            }
            return fetchImpl(input, init)
        }) as typeof fetch

        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://sync.example',
            syncToken: fixedSyncToken('t'),
            fetch: rejectingFetch,
            retry: { sleep: async () => {} },
        })
        await expect(
            store.save({ name: 'pic.png', bytes: new Uint8Array(4) as Uint8Array<ArrayBuffer>, type: 'image/png' }),
        ).rejects.toThrow('asset begin failed: 400')
        expect(begins).toBe(1)
    })

    it('gives up after the attempt budget rather than retrying forever', async () => {
        const { fetchImpl } = fakeBackend()
        let begins = 0
        const downFetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString()
            if (url.endsWith('/api/v1/sync/assets') && init?.method === 'POST') {
                begins += 1
                return new Response(null, { status: 500 })
            }
            return fetchImpl(input, init)
        }) as typeof fetch

        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://sync.example',
            syncToken: fixedSyncToken('t'),
            fetch: downFetch,
            retry: { attempts: 3, sleep: async () => {} },
        })
        await expect(
            store.save({ name: 'pic.png', bytes: new Uint8Array(4) as Uint8Array<ArrayBuffer>, type: 'image/png' }),
        ).rejects.toThrow('asset begin failed: 500')
        expect(begins).toBe(3)
    })

    it('keeps the asset when only the cosmetic complete call fails for good', async () => {
        // Chunks and metadata are already durable; `status` is informational. Losing the
        // upload over it would be the exact trade the retry exists to prevent.
        const { fetchImpl, objects } = fakeBackend()
        const noCompleteFetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString()
            if (/\/api\/v1\/sync\/assets\/[^/]+\/[^/]+$/.test(url) && init?.method === 'POST') {
                return new Response(null, { status: 500 })
            }
            return fetchImpl(input, init)
        }) as typeof fetch

        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://sync.example',
            syncToken: fixedSyncToken('t'),
            fetch: noCompleteFetch,
            newAssetId: () => '00000000-0000-4000-8000-000000000001',
            retry: { attempts: 2, sleep: async () => {} },
        })
        const saved = await store.save({
            name: 'pic.png',
            bytes: new TextEncoder().encode('bytes') as Uint8Array<ArrayBuffer>,
            type: 'image/png',
        })
        expect(saved.ref).toContain('00000000-0000-4000-8000-000000000001')
        expect(objects.size).toBe(1)
    })

    it('stops on cancellation instead of waiting out its backoff', async () => {
        const { fetchImpl } = fakeBackend()
        const controller = new AbortController()
        const stallingFetch = (async (input: string | URL | Request, init?: RequestInit) => {
            const url = typeof input === 'string' ? input : input.toString()
            if (url.endsWith('/api/v1/sync/assets') && init?.method === 'POST') {
                controller.abort(new Error('Import cancelled'))
                return new Response(null, { status: 503 })
            }
            return fetchImpl(input, init)
        }) as typeof fetch

        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://sync.example',
            syncToken: fixedSyncToken('t'),
            fetch: stallingFetch,
            signal: controller.signal,
            retry: { baseDelayMs: 60_000 }, // a real wait: cancellation must not sit through it
        })
        await expect(
            store.save({ name: 'pic.png', bytes: new Uint8Array(4) as Uint8Array<ArrayBuffer>, type: 'image/png' }),
        ).rejects.toThrow('Import cancelled')
    })

    describe('within-graph reuse (ADR 0053)', () => {
        const bytes = () => new TextEncoder().encode('SAME-BYTES-'.repeat(50)) as Uint8Array<ArrayBuffer>

        function storeOver(backend: ReturnType<typeof fakeBackend>, keyring = createGraphKeyring('g1')) {
            let id = 0
            return createServerAssetStore({
                graphId: 'g1',
                keyring,
                baseUrl: 'https://sync.example',
                syncToken: fixedSyncToken('sync-tok'),
                fetch: backend.fetchImpl,
                newAssetId: () => `00000000-0000-4000-8000-00000000000${++id}`,
            })
        }

        it('sends a blinded token with begin, never the plaintext hash', async () => {
            const backend = fakeBackend()
            const store = storeOver(backend)
            await store.save({ name: 'pic.png', bytes: bytes(), type: 'image/png' })
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes()))
            const plaintextHash = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('')
            expect(backend.begins).toHaveLength(1)
            expect(backend.begins[0].dedupToken).toMatch(/^[0-9a-f]{64}$/)
            expect(backend.begins[0].dedupToken).not.toBe(plaintextHash)
        })

        it('saving the same bytes twice uploads once and references the first asset id under the new name', async () => {
            const backend = fakeBackend()
            const store = storeOver(backend)
            const first = await store.save({ name: 'holiday.jpg', bytes: bytes(), type: 'image/jpeg' })
            const objectsAfterFirst = backend.objects.size
            let reported = 0
            const second = await store.save(
                { name: 'image-2026-09-02-14-32-08.jpg', bytes: bytes(), type: 'image/jpeg' },
                (n) => (reported += n),
            )
            expect(second.reused).toBe(true)
            expect(first.reused).toBeFalsy()
            // The same asset id, wearing the pasted file's own stem: resolution reads only the id.
            expect(second.ref).toBe('../assets/image-2026-09-02-14-32-08.00000000-0000-4000-8000-000000000001.jpg')
            expect(backend.objects.size).toBe(objectsAfterFirst) // nothing new in the bucket
            expect(backend.assets.size).toBe(1)
            // Progress still reports the bytes as retired, so an Activity bar completes.
            expect(reported).toBe(bytes().length)
            // The reused ref still resolves to the original bytes.
            const created: Blob[] = []
            vi.stubGlobal('URL', { createObjectURL: (b: Blob) => { created.push(b); return 'blob:mem/2' }, revokeObjectURL: () => {} })
            expect((await store.resolve(second.ref))?.url).toBe('blob:mem/2')
            expect(await created[0].text()).toBe(new TextDecoder().decode(bytes()))
            vi.unstubAllGlobals()
        })

        it('different bytes get different tokens and their own upload', async () => {
            const backend = fakeBackend()
            const store = storeOver(backend)
            await store.save({ name: 'a.png', bytes: bytes(), type: 'image/png' })
            const other = new TextEncoder().encode('OTHER-BYTES') as Uint8Array<ArrayBuffer>
            const second = await store.save({ name: 'b.png', bytes: other, type: 'image/png' })
            expect(second.reused).toBeFalsy()
            expect(backend.assets.size).toBe(2)
            expect(backend.begins[0].dedupToken).not.toBe(backend.begins[1].dedupToken)
        })
    })

    it('resolve returns null for a non-asset ref', async () => {
        const { fetchImpl } = fakeBackend()
        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://s',
            syncToken: fixedSyncToken('t'),
            fetch: fetchImpl,
        })
        expect(await store.resolve('not-an-asset')).toBeNull()
    })
})

describe('ServerAssetStore.resolve', () => {
    it('hands back the uploader\'s own file name and MIME type from the encrypted metadata', async () => {
        const { fetchImpl } = fakeBackend()
        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://sync.example',
            syncToken: fixedSyncToken('sync-tok'),
            fetch: fetchImpl,
            newAssetId: () => '00000000-0000-4000-8000-000000000001',
        })
        const bytes = new TextEncoder().encode('%PDF-1.7') as Uint8Array<ArrayBuffer>
        // Saved under a name the ref cannot carry: the ref is kebab-cased, the metadata is not.
        const saved = await store.save({ name: 'Q3 Report.pdf', bytes, type: 'application/pdf' })

        const created: Blob[] = []
        vi.stubGlobal('URL', { createObjectURL: (b: Blob) => { created.push(b); return 'blob:mem/1' }, revokeObjectURL: () => {} })
        const resolved = await store.resolve(saved.ref)
        vi.unstubAllGlobals()

        expect(resolved).toEqual({ url: 'blob:mem/1', name: 'Q3 Report.pdf', type: 'application/pdf' })
        expect(created[0].type).toBe('application/pdf')
    })

    it('returns null for a reference carrying no asset id', async () => {
        const { fetchImpl } = fakeBackend()
        const store = createServerAssetStore({
            graphId: 'g1',
            keyring: createGraphKeyring('g1'),
            baseUrl: 'https://sync.example',
            syncToken: fixedSyncToken('sync-tok'),
            fetch: fetchImpl,
        })

        expect(await store.resolve('not-an-asset')).toBeNull()
    })
})

describe('assetIdFromRef', () => {
    it('reads the id out of a reference as a document writes it', () => {
        expect(assetIdFromRef('../assets/q3-report.7f3a1b2c-0000-4000-8000-000000000001.pdf')).toBe(
            '7f3a1b2c-0000-4000-8000-000000000001',
        )
    })

    it('accepts identity on its own, which is how the asset View addresses a tab', () => {
        expect(assetIdFromRef('../assets/7f3a1b2c-0000-4000-8000-000000000001.pdf')).toBe(
            '7f3a1b2c-0000-4000-8000-000000000001',
        )
        expect(assetIdFromRef('../assets/7f3a1b2c-0000-4000-8000-000000000001')).toBe(
            '7f3a1b2c-0000-4000-8000-000000000001',
        )
    })

    it('refuses anything that is not an asset id', () => {
        expect(assetIdFromRef('../assets/holiday.png')).toBeNull()
        expect(assetIdFromRef('not-an-asset')).toBeNull()
        expect(assetIdFromRef('../pages/Note.md')).toBeNull()
    })
})
