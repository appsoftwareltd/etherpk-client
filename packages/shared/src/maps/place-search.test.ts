import { describe, expect, it } from 'vitest'

import {
    GEOAPIFY_CREDIT,
    OPENSTREETMAP_CREDIT,
    PLACE_SEARCH_MAX_CREDITS,
    PLACE_SEARCH_MAX_RESULTS,
    photonLanguage,
    photonReverseUrl,
    placeReverseRequestSchema,
    placeSearchRequestSchema,
    readPlaceCredits,
    readPlaceFeatures,
} from './place-search'

// What a Client asks a Sync Server's place search, and how an answer from any service is read:
// the fields a Client shows, nothing else, and no feature that does not read as a place.

const feature = (lon: number, lat: number, properties: Record<string, unknown> = {}) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties,
})

describe('a place search request', () => {
    it('takes a query, where the map is looking and a language', () => {
        expect(placeSearchRequestSchema.parse({ q: ' Brookmouth ', near: { lat: 50.6, lon: -1.2 }, lang: 'en' })).toEqual({
            q: 'Brookmouth',
            near: { lat: 50.6, lon: -1.2 },
            lang: 'en',
        })
    })

    it('refuses an empty or overlong query, a point off the globe and any other field', () => {
        expect(placeSearchRequestSchema.safeParse({ q: '   ' }).success).toBe(false)
        expect(placeSearchRequestSchema.safeParse({ q: 'x'.repeat(201) }).success).toBe(false)
        expect(placeSearchRequestSchema.safeParse({ q: 'Brookmouth', near: { lat: 91, lon: 0 } }).success).toBe(false)
        expect(placeSearchRequestSchema.safeParse({ q: 'Brookmouth', apiKey: 'x' }).success).toBe(false)
    })
})

describe('a request for the place nearest a point', () => {
    it('takes a point on the earth and a language, and nothing else', () => {
        expect(placeReverseRequestSchema.parse({ point: { lat: 50.6, lon: -1.2 }, lang: 'en' })).toEqual({ point: { lat: 50.6, lon: -1.2 }, lang: 'en' })
        expect(placeReverseRequestSchema.safeParse({ point: { lat: 91, lon: 0 } }).success).toBe(false)
        expect(placeReverseRequestSchema.safeParse({}).success).toBe(false)
        expect(placeReverseRequestSchema.safeParse({ point: { lat: 50.6, lon: -1.2 }, q: 'Garden' }).success).toBe(false)
    })
})

describe('asking a Photon server', () => {
    it('names places in the languages Photon has, and in their own for any other', () => {
        expect(photonLanguage('en')).toBe('en')
        expect(photonLanguage('fr')).toBe('fr')
        expect(photonLanguage('es')).toBeUndefined()
        expect(photonLanguage(undefined)).toBeUndefined()
    })

    it('finds the reverse lookup beside the search API', () => {
        expect(photonReverseUrl('https://photon.example.com/api')).toBe('https://photon.example.com/reverse')
        expect(photonReverseUrl('https://photon.example.com/api/')).toBe('https://photon.example.com/reverse')
        expect(photonReverseUrl('https://example.com/photon/api?x=1')).toBe('https://example.com/photon/reverse')
        expect(photonReverseUrl('https://photon.example.com/')).toBe('https://photon.example.com/reverse')
    })
})

describe('reading an answer', () => {
    it('keeps the address fields and drops what a service adds of its own', () => {
        const [read] = readPlaceFeatures([feature(-1.2, 50.6, { name: 'Brookmouth', city: 'Brookmouth', osm_id: 1, extent: [1, 2, 3, 4] })])
        expect(read.properties).toEqual({ name: 'Brookmouth', city: 'Brookmouth' })
        expect(read.geometry.coordinates).toEqual([-1.2, 50.6])
    })

    it('drops a feature that does not read as a place, and keeps the rest', () => {
        const read = readPlaceFeatures([feature(-1.2, 95), { type: 'Feature', geometry: null, properties: {} }, feature(-1.2, 50.6, { name: 'Brookmouth' })])
        expect(read.map((f) => f.properties.name)).toEqual(['Brookmouth'])
    })

    it('keeps at most the limit', () => {
        const many = Array.from({ length: 20 }, (_, i) => feature(0, i, { name: `P${i}` }))
        expect(readPlaceFeatures(many)).toHaveLength(PLACE_SEARCH_MAX_RESULTS)
    })
})

describe("reading an answer's credits", () => {
    it('keeps the credits a service asks for, each with its words and an https link', () => {
        expect(readPlaceCredits([GEOAPIFY_CREDIT, OPENSTREETMAP_CREDIT])).toEqual([
            { text: 'Powered by Geoapify', url: 'https://www.geoapify.com/' },
            { text: '© OpenStreetMap', url: 'https://www.openstreetmap.org/copyright' },
        ])
    })

    it('drops a credit a Client could not show safely, and reads anything but a list as none', () => {
        expect(
            readPlaceCredits([
                { text: 'Click me', url: 'javascript:alert(1)' },
                { text: 'Plain', url: 'http://example.com/' },
                { text: '', url: 'https://example.com/' },
                { text: 'No link' },
                'text',
                OPENSTREETMAP_CREDIT,
            ]),
        ).toEqual([OPENSTREETMAP_CREDIT])
        expect(readPlaceCredits(undefined)).toEqual([])
        expect(readPlaceCredits({ text: 'one', url: 'https://example.com/' })).toEqual([])
        expect(readPlaceCredits(Array.from({ length: 9 }, () => OPENSTREETMAP_CREDIT))).toHaveLength(PLACE_SEARCH_MAX_CREDITS)
    })
})
