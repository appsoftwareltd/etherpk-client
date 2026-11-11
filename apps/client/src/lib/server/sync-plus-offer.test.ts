import { describe, expect, it, vi } from 'vitest'
import { createSyncPlusOfferReader } from './sync-plus-offer'

type Fetch = typeof fetch

const ORIGIN = 'https://www.example.com'
// Made-up figures: no deployment's price belongs in this repository's Client.
const TERMS = { billingEnabled: true, priceDisplay: '¤12.34', billingInterval: 'month', trialDays: 9 }

const answering = (body: unknown, init: ResponseInit = {}) =>
    vi.fn<Fetch>(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), init))

describe('reading the Sync+ terms from the account site', () => {
    it('asks the configured origin, with no credentials and no redirects followed', async () => {
        const fetch = answering(TERMS)
        expect(await createSyncPlusOfferReader({ fetch })(ORIGIN)).toEqual(TERMS)
        const [url, init] = fetch.mock.calls[0]
        expect(url).toBe('https://www.example.com/api/v1/sync-plus-offer')
        expect(init).toMatchObject({ credentials: 'omit', redirect: 'error' })
        expect(init?.signal).toBeInstanceOf(AbortSignal)
    })

    it.each([
        ['an error status', answering(TERMS, { status: 503 })],
        ['a body that is not JSON', answering('<!doctype html>')],
        ['a body of another shape', answering({ ...TERMS, priceDisplay: '' })],
        ['an oversized body', answering({ ...TERMS, padding: 'x'.repeat(5000) })],
        ['a failed request', vi.fn<Fetch>(async () => { throw new TypeError('fetch failed') })],
    ])('reads %s as not known', async (_name, fetch) => {
        expect(await createSyncPlusOfferReader({ fetch })(ORIGIN)).toBeNull()
    })

    it('gives up on an account site that does not answer in time', async () => {
        const fetch = vi.fn<Fetch>((_url, init) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        }))
        expect(await createSyncPlusOfferReader({ fetch, timeoutMs: 20 })(ORIGIN)).toBeNull()
    })

    it('keeps an answer for five minutes, and "not known" for one', async () => {
        let time = 0
        const fetch = answering(TERMS)
        const read = createSyncPlusOfferReader({ fetch, now: () => time })
        await read(ORIGIN)
        time = 5 * 60_000 - 1
        await read(ORIGIN)
        expect(fetch).toHaveBeenCalledTimes(1)

        const failing = answering(TERMS, { status: 500 })
        const readFailing = createSyncPlusOfferReader({ fetch: failing, now: () => time })
        await readFailing(ORIGIN)
        time += 59_000
        await readFailing(ORIGIN)
        expect(failing).toHaveBeenCalledTimes(1)
        time += 2_000
        await readFailing(ORIGIN)
        expect(failing).toHaveBeenCalledTimes(2)
    })

    it('serves a stale answer at once and fetches the new one behind it', async () => {
        let time = 0
        let body: unknown = TERMS
        const fetch = vi.fn<Fetch>(async () => new Response(JSON.stringify(body)))
        const read = createSyncPlusOfferReader({ fetch, now: () => time })
        await read(ORIGIN)

        time = 6 * 60_000
        body = { ...TERMS, trialDays: 0 }
        expect(await read(ORIGIN)).toEqual(TERMS)
        await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
        await vi.waitFor(async () => expect(await read(ORIGIN)).toEqual({ ...TERMS, trialDays: 0 }))
    })

    it('shares one call between requests that arrive together', async () => {
        const fetch = answering(TERMS)
        const read = createSyncPlusOfferReader({ fetch })
        expect(await Promise.all([read(ORIGIN), read(ORIGIN), read(ORIGIN)])).toEqual([TERMS, TERMS, TERMS])
        expect(fetch).toHaveBeenCalledTimes(1)
    })
})
