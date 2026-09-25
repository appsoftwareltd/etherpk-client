/**
 * Dictionaries from EtherPK's dictionary host (ADR 0095; Spelling Dictionaries.md), kept on the
 * device.
 *
 * The files live under immutable, versioned paths, so a dictionary is downloaded once, checked
 * against the manifest's SHA-256 and kept in Cache Storage; after that a language loads from the
 * device with no network at all. The manifest is fetched from the network when it can be (so a
 * new language on the host shows up) and falls back to the copy last seen when offline.
 *
 * Everything the browser provides is passed in, so the rules run under Node in the tests.
 */

import { parseManifest, type DictionaryEntry, type DictionaryManifest } from './languages'

export type DictionaryErrorKind = 'unconfigured' | 'offline' | 'http' | 'integrity' | 'manifest'

export class DictionaryError extends Error {
    constructor(
        readonly kind: DictionaryErrorKind,
        message: string,
    ) {
        super(message)
        this.name = 'DictionaryError'
    }
}

export interface DictionaryFiles {
    aff: string
    dic: string
}

export interface DictionaryCacheDeps {
    /** The host's versioned base, e.g. `https://dictionaries.etherpk.com/v1`. Empty: no host. */
    baseUrl: string
    fetch: typeof fetch
    /** The Cache Storage cache to keep files in, or null where there is none. */
    cache: () => Promise<Cache | null>
    /** Hex SHA-256 of some bytes. */
    sha256: (bytes: ArrayBuffer) => Promise<string>
}

export interface DictionaryCache {
    /** False when the deployment set no dictionary host: spell checking then has no languages. */
    readonly configured: boolean
    manifest(): Promise<DictionaryManifest>
    files(entry: DictionaryEntry): Promise<DictionaryFiles>
    isCached(entry: DictionaryEntry): Promise<boolean>
}

const decoder = new TextDecoder('utf-8')

export function createDictionaryCache(deps: DictionaryCacheDeps): DictionaryCache {
    const base = deps.baseUrl.trim().replace(/\/+$/, '')
    const url = (path: string) => `${base}/${path}`

    async function openCache(): Promise<Cache | null> {
        try {
            return await deps.cache()
        } catch {
            return null // private mode, storage blocked: download each time instead
        }
    }

    async function download(target: string): Promise<ArrayBuffer> {
        let response: Response
        try {
            response = await deps.fetch(target)
        } catch {
            throw new DictionaryError('offline', `Could not reach the dictionary host at ${base}.`)
        }
        if (!response.ok) {
            throw new DictionaryError('http', `The dictionary host answered ${response.status} for ${target}.`)
        }
        return response.arrayBuffer()
    }

    /** One file, from the device if it is there, otherwise downloaded and checked. */
    async function file(path: string, expectedHash: string, cache: Cache | null): Promise<ArrayBuffer> {
        const target = url(path)
        const held = await cache?.match(target)
        if (held) return held.arrayBuffer()
        const bytes = await download(target)
        if ((await deps.sha256(bytes)) !== expectedHash) {
            throw new DictionaryError('integrity', `${path} does not match the dictionary manifest.`)
        }
        return bytes
    }

    function requireHost(): void {
        if (!base) throw new DictionaryError('unconfigured', 'No dictionary host is configured for this deployment.')
    }

    return {
        configured: base !== '',

        async manifest() {
            requireHost()
            const target = url('manifest.json')
            const cache = await openCache()
            let text: string
            try {
                text = decoder.decode(await download(target))
                await cache?.put(target, new Response(text, { headers: { 'content-type': 'application/json' } }))
            } catch (err) {
                const held = await cache?.match(target)
                if (!held) throw err
                text = await held.text()
            }
            try {
                return parseManifest(JSON.parse(text))
            } catch (err) {
                throw new DictionaryError('manifest', (err as Error).message)
            }
        },

        async files(entry) {
            requireHost()
            const cache = await openCache()
            const [aff, dic] = await Promise.all([
                file(entry.aff, entry.sha256.aff, cache),
                file(entry.dic, entry.sha256.dic, cache),
            ])
            // Both verified before either is kept, so a half-good pair never sits in the cache.
            await cache?.put(url(entry.aff), new Response(aff))
            await cache?.put(url(entry.dic), new Response(dic))
            return { aff: decoder.decode(aff), dic: decoder.decode(dic) }
        },

        async isCached(entry) {
            if (!base) return false
            const cache = await openCache()
            if (!cache) return false
            return Boolean((await cache.match(url(entry.aff))) && (await cache.match(url(entry.dic))))
        },
    }
}
