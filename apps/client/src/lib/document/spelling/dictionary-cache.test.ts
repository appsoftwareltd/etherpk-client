import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { createDictionaryCache, DictionaryError, type DictionaryCacheDeps } from './dictionary-cache'
import type { DictionaryEntry } from './languages'

const hex = (text: string) => createHash('sha256').update(text).digest('hex')
const AFF = 'SET UTF-8\n'
const DIC = '1\nword\n'
const ENTRY: DictionaryEntry = {
    tag: 'en-GB',
    aff: 'en-GB/index.aff',
    dic: 'en-GB/index.dic',
    license: 'en-GB/LICENSE',
    licence: 'MIT',
    bytes: AFF.length + DIC.length,
    sha256: { aff: hex(AFF), dic: hex(DIC) },
}
const MANIFEST = { version: 1, source: 'test', dictionaries: [ENTRY] }
const BASE = 'https://dictionaries.example.com/v1'

/** A Cache Storage `Cache` stand-in keyed by URL. */
function memoryCache(): Cache & { keysSeen(): string[] } {
    const store = new Map<string, Response>()
    return {
        match: async (req: RequestInfo | URL) => store.get(String(req))?.clone(),
        put: async (req: RequestInfo | URL, res: Response) => void store.set(String(req), res.clone()),
        delete: async (req: RequestInfo | URL) => store.delete(String(req)),
        keysSeen: () => [...store.keys()],
    } as unknown as Cache & { keysSeen(): string[] }
}

function deps(files: Record<string, string | Response>, cache: Cache | null = memoryCache()): DictionaryCacheDeps & {
    fetch: ReturnType<typeof vi.fn>
} {
    const fetch = vi.fn(async (url: string) => {
        const body = files[url]
        if (body === undefined) return new Response('missing', { status: 404 })
        return body instanceof Response ? body : new Response(body)
    })
    return {
        baseUrl: `${BASE}/`,
        fetch: fetch as unknown as typeof globalThis.fetch & ReturnType<typeof vi.fn>,
        cache: async () => cache,
        sha256: async (bytes) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex'),
    }
}

const HOST = {
    [`${BASE}/manifest.json`]: JSON.stringify(MANIFEST),
    [`${BASE}/en-GB/index.aff`]: AFF,
    [`${BASE}/en-GB/index.dic`]: DIC,
}

describe('dictionary cache', () => {
    it('reads the manifest from the host', async () => {
        const manifest = await createDictionaryCache(deps(HOST)).manifest()
        expect(manifest.dictionaries.map((d) => d.tag)).toEqual(['en-GB'])
    })

    it('downloads a dictionary once, then serves it from the device', async () => {
        const d = deps(HOST)
        const cache = createDictionaryCache(d)
        expect(await cache.isCached(ENTRY)).toBe(false)
        expect(await cache.files(ENTRY)).toEqual({ aff: AFF, dic: DIC })
        expect(await cache.isCached(ENTRY)).toBe(true)
        d.fetch.mockClear()
        expect(await cache.files(ENTRY)).toEqual({ aff: AFF, dic: DIC })
        expect(d.fetch).not.toHaveBeenCalled()
    })

    it('refuses a file whose hash does not match the manifest, and caches nothing', async () => {
        const d = deps({ ...HOST, [`${BASE}/en-GB/index.dic`]: '1\ntampered\n' })
        const cache = createDictionaryCache(d)
        await expect(cache.files(ENTRY)).rejects.toMatchObject({ kind: 'integrity' })
        expect(await cache.isCached(ENTRY)).toBe(false)
    })

    it('says offline when the network is unreachable, and HTTP when the host answers badly', async () => {
        const offline = deps(HOST)
        offline.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
        await expect(createDictionaryCache(offline).files(ENTRY)).rejects.toMatchObject({ kind: 'offline' })

        const missing = createDictionaryCache(deps({ [`${BASE}/manifest.json`]: JSON.stringify(MANIFEST) }))
        const error = await missing.files(ENTRY).catch((e: unknown) => e)
        expect(error).toBeInstanceOf(DictionaryError)
        expect(error).toMatchObject({ kind: 'http' })
    })

    it('falls back to the manifest it saw last when offline', async () => {
        const cacheStore = memoryCache()
        const online = deps(HOST, cacheStore)
        await createDictionaryCache(online).manifest()
        const offline = deps(HOST, cacheStore)
        offline.fetch.mockRejectedValue(new TypeError('Failed to fetch'))
        expect((await createDictionaryCache(offline).manifest()).dictionaries).toHaveLength(1)
    })

    it('still works where Cache Storage is unavailable, downloading each time', async () => {
        const d = deps(HOST, null)
        const cache = createDictionaryCache(d)
        expect(await cache.files(ENTRY)).toEqual({ aff: AFF, dic: DIC })
        expect(await cache.isCached(ENTRY)).toBe(false)
    })

    it('has no host at all when the address is empty', async () => {
        const cache = createDictionaryCache({ ...deps(HOST), baseUrl: '  ' })
        expect(cache.configured).toBe(false)
        await expect(cache.manifest()).rejects.toMatchObject({ kind: 'unconfigured' })
    })
})
