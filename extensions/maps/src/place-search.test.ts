import { describe, expect, it, vi } from 'vitest'

import type { PlaceSearchFeature } from '@appsoftwareltd/etherpk-shared'

import { SyncApiError } from '$lib/sync/sync-api'

import { createPlaceSearch, type PlaceSearchServer, placeResults, ukPostcode } from './place-search'

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
                feature(-1.2, 50.6, { name: 'Ventnor', county: 'Isle of Wight', country: 'United Kingdom' }),
                feature(-0.1276, 51.5034, { housenumber: '10', street: 'Downing Street', postcode: 'SW1A 2AA', city: 'London', country: 'United Kingdom' }),
            ],
            'anything',
        )
        expect(results).toEqual([
            { name: 'Ventnor', detail: 'Isle of Wight, United Kingdom', point: { lat: 50.6, lon: -1.2 }, postcode: undefined },
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
        expect(ukPostcode('Ventnor')).toBeNull()
        expect(ukPostcode('SW1A')).toBeNull()
    })
})

function connection(searchPlaces: (...args: unknown[]) => Promise<{ features?: unknown }>): PlaceSearchServer {
    return { origin: 'https://sync.example.com', api: { searchPlaces } }
}

describe('searching', () => {
    it('asks the Sync Server with the words, where the map is looking and the language', async () => {
        const credits = [
            { text: 'Powered by Geoapify', url: 'https://www.geoapify.com/' },
            { text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' },
        ]
        const searchPlaces = vi.fn(async () => ({ type: 'FeatureCollection', features: [feature(-1.2, 50.6, { name: 'Ventnor' })], credits }))
        const search = createPlaceSearch({ server: () => connection(searchPlaces), photonUrl: null, offersSyncPlus: true, language: () => 'en-GB' })
        expect(search.availability()).toEqual({ available: true })
        const signal = new AbortController().signal
        const answer = await search.search('Ventnor', { lat: 50.6, lon: -1.2 }, signal)
        expect(searchPlaces).toHaveBeenCalledWith({ q: 'Ventnor', near: { lat: 50.6, lon: -1.2 }, lang: 'en' }, signal)
        expect(answer.results.map((r) => r.name)).toEqual(['Ventnor'])
        // The credits the server's service asks for come with the places.
        expect(answer.credits).toEqual(credits)
    })

    it("credits OpenStreetMap where the server names no credits, and never shows a link that isn't https", async () => {
        const answering = (credits: unknown) =>
            createPlaceSearch({
                server: () => connection(vi.fn(async () => ({ type: 'FeatureCollection', features: [], credits }))),
                photonUrl: null,
                offersSyncPlus: true,
                language: () => 'en',
            }).search('Ventnor', null, new AbortController().signal)
        const openStreetMap = [{ text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' }]
        expect((await answering(undefined)).credits).toEqual(openStreetMap)
        expect((await answering([{ text: 'Click me', url: 'javascript:alert(1)' }])).credits).toEqual(openStreetMap)
    })

    it('asks a Photon server a deployment names directly, needing no account', async () => {
        const fetch = vi.fn(async (_url: RequestInfo | URL) => new Response(JSON.stringify({ type: 'FeatureCollection', features: [feature(-1.2, 50.6, { name: 'Ventnor' })] })))
        const search = createPlaceSearch({ server: () => null, photonUrl: 'https://photon.example.com/api', offersSyncPlus: true, language: () => 'fr', fetch })
        expect(search.availability()).toEqual({ available: true })
        const answer = await search.search('Ventnor', null, new AbortController().signal)
        const asked = new URL(String(fetch.mock.calls[0][0]))
        expect(Object.fromEntries(asked.searchParams)).toEqual({ q: 'Ventnor', limit: '8', lang: 'fr' })
        expect(answer.credits).toEqual([{ text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' }])
    })

    it('says up front that searching by name comes with Sync+ when the device has no Sync Server', () => {
        const search = createPlaceSearch({ server: () => null, photonUrl: null, offersSyncPlus: true, language: () => 'en' })
        expect(search.availability()).toEqual({ available: false, reason: expect.stringMatching(/^Searching by name comes with Sync\+\. Type coordinates/) })
        const selfHosted = createPlaceSearch({ server: () => null, photonUrl: null, offersSyncPlus: false, language: () => 'en' })
        expect(selfHosted.availability()).toEqual({ available: false, reason: expect.stringMatching(/^Searching by name isn't set up here\. Type coordinates/) })
    })

    it("turns the server's refusals into what to do instead", async () => {
        const refusing = (error: unknown) =>
            createPlaceSearch({ server: () => connection(vi.fn(async () => Promise.reject(error))), photonUrl: null, offersSyncPlus: true, language: () => 'en' }).search(
                'Ventnor',
                null,
                new AbortController().signal,
            )
        await expect(refusing(new SyncApiError('no', 403, 'place_search_plan'))).rejects.toThrow(/^Searching by name comes with Sync\+\./)
        await expect(refusing(new SyncApiError('no', 404, 'place_search_off'))).rejects.toThrow(/^sync\.example\.com doesn't search for places by name\./)
        await expect(refusing(new SyncApiError('no', 429))).rejects.toThrow('Too many searches. Wait a minute, then try again.')
        await expect(refusing(new SyncApiError('no', 401))).rejects.toThrow(/Sign in to sync\.example\.com again/)
        await expect(refusing(new SyncApiError('no', 502, 'place_search_unavailable'))).rejects.toThrow(/isn't answering/)
        await expect(refusing(new TypeError('Failed to fetch'))).rejects.toThrow(/didn't reach sync\.example\.com/)
    })

    it('lets a search the person replaced end quietly', async () => {
        const aborted = new DOMException('The operation was aborted.', 'AbortError')
        const search = createPlaceSearch({ server: () => connection(vi.fn(async () => Promise.reject(aborted))), photonUrl: null, offersSyncPlus: true, language: () => 'en' })
        await expect(search.search('Ventnor', null, new AbortController().signal)).rejects.toBe(aborted)
    })
})
