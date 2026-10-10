import { describe, expect, it, vi } from 'vitest'

import type { PlaceSearchFeature } from '@appsoftwareltd/etherpk-shared'

import { SyncApiError } from '$lib/sync/sync-api'

import { createPlaceSearch, nearestPlaceName, type PlaceSearchOptions, type PlaceSearchServer, placeResults, ukPostcode } from './place-search'

// Searching for a place by name in a Map Block (ADR 0119): through the graph's Sync Server, which
// decides whether the account may search, or a Photon server a deployment names; the answer read
// as places, and every refusal turned into what the person can do instead.

const feature = (lon: number, lat: number, properties: PlaceSearchFeature['properties']): PlaceSearchFeature => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties,
})

describe('reading the places found', () => {
    it('names a place by its name, or by its address when it has none, and says where it is', () => {
        const results = placeResults(
            [
                feature(-1.2, 50.6, { name: 'Brookmouth', county: 'Westshire', country: 'United Kingdom' }),
                feature(-0.1276, 51.5034, { housenumber: '10', street: 'Downing Street', postcode: 'SW1A 2AA', city: 'London', country: 'United Kingdom' }),
            ],
            'anything',
        )
        expect(results).toEqual([
            { name: 'Brookmouth', detail: 'Westshire, United Kingdom', point: { lat: 50.6, lon: -1.2 }, postcode: undefined },
            { name: '10 Downing Street', detail: 'London, SW1A 2AA, United Kingdom', point: { lat: 51.5034, lon: -0.1276 }, postcode: 'SW1A 2AA' },
        ])
    })

    it('keeps only the places with the very postcode typed, for a full UK postcode', () => {
        const found = [
            feature(-0.14, 51.5, { name: 'SW1A 1AA', postcode: 'SW1A 1AA' }),
            feature(-0.13, 51.5, { name: 'SW1A 2AA', postcode: 'sw1a 2aa' }),
        ]
        expect(placeResults(found, 'sw1a2aa').map((r) => r.name)).toEqual(['SW1A 2AA'])
        expect(placeResults(found, 'SW1A 9ZZ')).toEqual([])
        // Anything else is searched as typed.
        expect(placeResults(found, 'SW1A')).toHaveLength(2)
    })

    it('reads a UK postcode however it is spaced or cased', () => {
        expect(ukPostcode(' sw1a 2aa ')).toBe('SW1A2AA')
        expect(ukPostcode('M1 1AE')).toBe('M11AE')
        expect(ukPostcode('B33 8TH')).toBe('B338TH')
        expect(ukPostcode('Brookmouth')).toBeNull()
        expect(ukPostcode('SW1A')).toBeNull()
    })
})

function connection(searchPlaces: (...args: unknown[]) => Promise<{ features?: unknown }>, api: Partial<PlaceSearchServer['api']> = {}): PlaceSearchServer {
    const unasked = vi.fn(async () => Promise.reject(new Error('not asked in this test')))
    return { origin: 'https://sync.example.com', api: { searchPlaces, reversePlace: unasked, openMapLink: unasked, ...api } }
}

/** A place search with this test's options over the usual ones. */
function placeSearch(options: Partial<PlaceSearchOptions>) {
    return createPlaceSearch({ server: () => null, photonUrl: null, offersSyncPlus: true, postcodes: true, language: () => 'en', ...options })
}

describe('searching', () => {
    it('asks the Sync Server with the words, where the map is looking and the language', async () => {
        const credits = [
            { text: 'Powered by Geoapify', url: 'https://www.geoapify.com/' },
            { text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' },
        ]
        const searchPlaces = vi.fn(async () => ({ type: 'FeatureCollection', features: [feature(-1.2, 50.6, { name: 'Brookmouth' })], credits }))
        const search = createPlaceSearch({ server: () => connection(searchPlaces), photonUrl: null, offersSyncPlus: true, postcodes: true, language: () => 'en-GB' })
        expect(search.availability()).toEqual({ available: true })
        const signal = new AbortController().signal
        const answer = await search.search('Brookmouth', { lat: 50.6, lon: -1.2 }, signal)
        expect(searchPlaces).toHaveBeenCalledWith({ q: 'Brookmouth', near: { lat: 50.6, lon: -1.2 }, lang: 'en' }, signal)
        expect(answer.results.map((r) => r.name)).toEqual(['Brookmouth'])
        // The credits the server's service asks for come with the places.
        expect(answer.credits).toEqual(credits)
    })

    it("credits OpenStreetMap where the server names no credits, and never shows a link that isn't https", async () => {
        const answering = (credits: unknown) =>
            createPlaceSearch({
                server: () => connection(vi.fn(async () => ({ type: 'FeatureCollection', features: [], credits }))),
                photonUrl: null,
                offersSyncPlus: true,
                postcodes: true,
                language: () => 'en',
            }).search('Brookmouth', null, new AbortController().signal)
        const openStreetMap = [{ text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' }]
        expect((await answering(undefined)).credits).toEqual(openStreetMap)
        expect((await answering([{ text: 'Click me', url: 'javascript:alert(1)' }])).credits).toEqual(openStreetMap)
    })

    it('asks a Photon server a deployment names directly, needing no account', async () => {
        const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({ type: 'FeatureCollection', features: [feature(-1.2, 50.6, { name: 'Brookmouth' })] })))
        const search = createPlaceSearch({ server: () => null, photonUrl: 'https://photon.example.com/api', offersSyncPlus: true, postcodes: true, language: () => 'fr', fetch })
        expect(search.availability()).toEqual({ available: true })
        const answer = await search.search('Brookmouth', null, new AbortController().signal)
        const asked = new URL(String(fetch.mock.calls[0][0]))
        expect(Object.fromEntries(asked.searchParams)).toEqual({ q: 'Brookmouth', limit: '8', lang: 'fr' })
        expect(answer.credits).toEqual([{ text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' }])
    })

    it('says up front that searching by place name needs Sync+ when the device has no Sync Server', () => {
        expect(placeSearch({}).availability()).toEqual({
            available: false,
            reason: 'Searching by place name needs Sync+. Type a UK or US postcode, coordinates such as 50.7486, -4.0789, or a Plus Code, or paste a link from Google Maps, Apple Maps or OpenStreetMap.',
        })
        expect(placeSearch({ offersSyncPlus: false }).availability()).toEqual({ available: false, reason: expect.stringMatching(/^Searching by place name isn't set up here\. Type a UK or US postcode,/) })
        // A deployment without the postcode files offers no postcodes.
        expect(placeSearch({ postcodes: false }).availability()).toEqual({ available: false, reason: expect.stringMatching(/needs Sync\+\. Type coordinates such as 50\.7486, -4\.0789, or a Plus Code, or paste/) })
    })

    it("turns the server's refusals into what to do instead", async () => {
        const refusing = (error: unknown) =>
            createPlaceSearch({ server: () => connection(vi.fn(async () => Promise.reject(error))), photonUrl: null, offersSyncPlus: true, postcodes: true, language: () => 'en' }).search(
                'Brookmouth',
                null,
                new AbortController().signal,
            )
        await expect(refusing(new SyncApiError('no', 403, 'place_search_plan'))).rejects.toThrow(/^Searching by place name needs Sync\+\. Type a UK or US postcode/)
        await expect(refusing(new SyncApiError('no', 404, 'place_search_off'))).rejects.toThrow(/^sync\.example\.com doesn't search for places by name\./)
        await expect(refusing(new SyncApiError('no', 429))).rejects.toThrow('Too many searches. Wait a minute, then try again.')
        await expect(refusing(new SyncApiError('no', 401))).rejects.toThrow(/Sign in to sync\.example\.com again/)
        await expect(refusing(new SyncApiError('no', 502, 'place_search_unavailable'))).rejects.toThrow(/isn't answering/)
        await expect(refusing(new TypeError('Failed to fetch'))).rejects.toThrow(/didn't reach sync\.example\.com/)
    })

    it('remembers a refusal from the plan or the server, so the box stops offering search there', async () => {
        const searchPlaces = vi.fn(async () => Promise.reject(new SyncApiError('no', 403, 'place_search_plan')))
        let server: PlaceSearchServer | null = connection(searchPlaces)
        const search = placeSearch({ server: () => server })
        expect(search.availability()).toEqual({ available: true })
        await expect(search.search('Garden Centre', null, new AbortController().signal)).rejects.toThrow(/needs Sync\+/)
        expect(search.availability()).toEqual({ available: false, reason: expect.stringMatching(/^Searching by place name needs Sync\+\./) })
        // Another server is asked afresh.
        server = { ...connection(searchPlaces), origin: 'https://other.example.com' }
        expect(search.availability()).toEqual({ available: true })
    })

    it('asks a Photon server only in a language it has', async () => {
        const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({ type: 'FeatureCollection', features: [] })))
        await placeSearch({ photonUrl: 'https://photon.example.com/api', language: () => 'es-ES', fetch }).search('Garden Centre', null, new AbortController().signal)
        expect(new URL(String(fetch.mock.calls[0][0])).searchParams.has('lang')).toBe(false)
    })

    it('lets a search the person replaced end quietly', async () => {
        const aborted = new DOMException('The operation was aborted.', 'AbortError')
        const search = createPlaceSearch({ server: () => connection(vi.fn(async () => Promise.reject(aborted))), photonUrl: null, offersSyncPlus: true, postcodes: true, language: () => 'en' })
        await expect(search.search('Brookmouth', null, new AbortController().signal)).rejects.toBe(aborted)
    })
})

describe('naming a place from the one nearest it', () => {
    const at = { lat: 50.6, lon: -1.2 }

    it('is the nearest place within about 100 metres, by its name or its address', () => {
        expect(nearestPlaceName(feature(-1.2, 50.6005, { name: 'Garden Centre', street: 'High Street', city: 'Brookmouth', country: 'United Kingdom' }), at)).toEqual({
            name: 'Garden Centre',
            detail: 'High Street, Brookmouth, United Kingdom',
        })
        expect(nearestPlaceName(feature(-1.2, 50.6, { housenumber: '1', street: 'High Street', postcode: 'BR1 1AA', city: 'Brookmouth' }), at)).toEqual({
            name: '1 High Street',
            detail: 'Brookmouth, BR1 1AA',
        })
    })

    it('is the village or town beyond that, without the far address', () => {
        expect(nearestPlaceName(feature(-1.2, 50.605, { name: 'Garden Centre', street: 'High Street', postcode: 'BR1 1AA', city: 'Brookmouth', county: 'Westshire' }), at)).toEqual({
            name: 'Brookmouth',
            detail: 'Westshire',
        })
        expect(nearestPlaceName(feature(-1.2, 50.7, { street: 'Farm Lane' }), at)).toEqual({ name: '', detail: '' })
    })
})

describe('asking for the place nearest a point', () => {
    const at = { lat: 50.6, lon: -1.2 }
    const nearby = { type: 'FeatureCollection', features: [feature(-1.2, 50.6, { name: 'Garden Centre', city: 'Brookmouth' })], credits: [{ text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' }] }

    it("asks the Sync Server, and answers with the place's name, address and credits", async () => {
        const reversePlace = vi.fn(async () => nearby)
        const search = placeSearch({ server: () => connection(vi.fn(), { reversePlace }), language: () => 'en-GB' })
        const signal = new AbortController().signal
        await expect(search.reverse(at, signal)).resolves.toEqual({ name: 'Garden Centre', detail: 'Brookmouth', credits: nearby.credits })
        expect(reversePlace).toHaveBeenCalledWith({ point: at, lang: 'en' }, signal)
    })

    it("asks a Photon server's reverse lookup directly, where a deployment names one", async () => {
        const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify(nearby)))
        const search = placeSearch({ photonUrl: 'https://photon.example.com/api', fetch })
        await expect(search.reverse(at, new AbortController().signal)).resolves.toMatchObject({ name: 'Garden Centre' })
        const asked = new URL(String(fetch.mock.calls[0][0]))
        expect(asked.origin + asked.pathname).toBe('https://photon.example.com/reverse')
        expect(Object.fromEntries(asked.searchParams)).toEqual({ lat: '50.6', lon: '-1.2', limit: '1', lang: 'en' })
    })

    it('answers nothing, quietly, where there is no answer or no search, and remembers a refusal', async () => {
        expect(await placeSearch({}).reverse(at, new AbortController().signal)).toBeNull()
        const empty = placeSearch({ server: () => connection(vi.fn(), { reversePlace: vi.fn(async () => ({ type: 'FeatureCollection', features: [] })) }) })
        expect(await empty.reverse(at, new AbortController().signal)).toBeNull()
        const refused = placeSearch({ server: () => connection(vi.fn(), { reversePlace: vi.fn(async () => Promise.reject(new SyncApiError('no', 404, 'place_search_off'))) }) })
        expect(await refused.reverse(at, new AbortController().signal)).toBeNull()
        expect(refused.availability()).toEqual({ available: false, reason: expect.stringMatching(/^sync\.example\.com doesn't search for places by name\./) })
        const down = placeSearch({ server: () => connection(vi.fn(), { reversePlace: vi.fn(async () => Promise.reject(new SyncApiError('no', 502))) }) })
        expect(await down.reverse(at, new AbortController().signal)).toBeNull()
        expect(down.availability()).toEqual({ available: true })
    })

    it('lets a lookup the person no longer needs end quietly', async () => {
        const aborted = new DOMException('The operation was aborted.', 'AbortError')
        const search = placeSearch({ server: () => connection(vi.fn(), { reversePlace: vi.fn(async () => Promise.reject(aborted)) }) })
        await expect(search.reverse(at, new AbortController().signal)).rejects.toBe(aborted)
    })
})

describe('opening a short map link', () => {
    it('asks the Sync Server for the full link', async () => {
        const openMapLink = vi.fn(async () => ({ url: 'https://www.google.com/maps/@50.6,-1.2,15z' }))
        const search = placeSearch({ server: () => connection(vi.fn(), { openMapLink }) })
        const signal = new AbortController().signal
        await expect(search.openShortLink('https://maps.app.goo.gl/AbCdEf123', signal)).resolves.toBe('https://www.google.com/maps/@50.6,-1.2,15z')
        expect(openMapLink).toHaveBeenCalledWith({ url: 'https://maps.app.goo.gl/AbCdEf123' }, signal)
    })

    it('answers nothing without a Sync Server, or when the server cannot open it', async () => {
        expect(await placeSearch({ photonUrl: 'https://photon.example.com/api' }).openShortLink('https://maps.app.goo.gl/AbCdEf123', new AbortController().signal)).toBeNull()
        const refusing = placeSearch({ server: () => connection(vi.fn(), { openMapLink: vi.fn(async () => Promise.reject(new SyncApiError('no', 404))) }) })
        expect(await refusing.openShortLink('https://maps.app.goo.gl/AbCdEf123', new AbortController().signal)).toBeNull()
        const odd = placeSearch({ server: () => connection(vi.fn(), { openMapLink: vi.fn(async () => ({ url: 42 }) as never) }) })
        expect(await odd.openShortLink('https://maps.app.goo.gl/AbCdEf123', new AbortController().signal)).toBeNull()
    })
})

describe('with the search and link services switched off', () => {
    const at = { lat: 50.6, lon: -1.2 }

    it('asks no service at all, and says where the switch is', async () => {
        const searchPlaces = vi.fn(async () => ({ type: 'FeatureCollection', features: [] }))
        const reversePlace = vi.fn(async () => ({ type: 'FeatureCollection', features: [] }))
        const openMapLink = vi.fn(async () => ({ url: 'https://www.google.com/maps/@50.6,-1.2,15z' }))
        const fetch = vi.fn()
        for (const search of [
            placeSearch({ server: () => connection(searchPlaces, { reversePlace, openMapLink }), enabled: () => false }),
            placeSearch({ photonUrl: 'https://photon.example.com/api', fetch, enabled: () => false }),
        ]) {
            expect(search.switchedOff()).toBe(true)
            expect(search.availability()).toEqual({
                available: false,
                reason: "Searching by place name is switched off in the Maps extension's settings. Type a UK or US postcode, coordinates such as 50.7486, -4.0789, or a Plus Code, or paste a link from Google Maps, Apple Maps or OpenStreetMap.",
            })
            await expect(search.search('Garden Centre', null, new AbortController().signal)).rejects.toThrow(/^Searching by place name is switched off/)
            expect(await search.reverse(at, new AbortController().signal)).toBeNull()
            expect(await search.openShortLink('https://maps.app.goo.gl/AbCdEf123', new AbortController().signal)).toBeNull()
        }
        expect(searchPlaces).not.toHaveBeenCalled()
        expect(reversePlace).not.toHaveBeenCalled()
        expect(openMapLink).not.toHaveBeenCalled()
        expect(fetch).not.toHaveBeenCalled()
    })

    it('is read at each question, and its changes are heard', async () => {
        let on = false
        const listeners: (() => void)[] = []
        const search = placeSearch({ server: () => connection(vi.fn()), enabled: () => on, subscribe: (listener) => (listeners.push(listener), () => {}) })
        const heard = vi.fn()
        search.subscribe(heard)
        expect(search.availability().available).toBe(false)
        on = true
        listeners.forEach((listener) => listener())
        expect(heard).toHaveBeenCalledTimes(1)
        expect(search.availability()).toEqual({ available: true })
        expect(search.switchedOff()).toBe(false)
    })
})
