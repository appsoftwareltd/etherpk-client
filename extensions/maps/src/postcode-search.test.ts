import { describe, expect, it, vi } from 'vitest'

import { createPostcodeLookup, postcodesUrl, recognisePostcode, regionOf } from './postcode-search'

// Postcodes found from the files the map host serves (ADR 0119, amendment of 2026-10-09): what a
// typed postcode is, read on the device, and the place the files give for it.

describe('a typed postcode', () => {
    it('is a full UK postcode with or without its space, in any case', () => {
        for (const typed of ['PO30 1AB', 'po301ab', '  PO30   1AB ']) {
            expect(recognisePostcode(typed, 'GB')).toEqual({ country: 'gb', district: 'PO30', unit: '1AB', label: 'PO30 1AB' })
        }
        expect(recognisePostcode('SW1A 1AA', null)).toEqual({ country: 'gb', district: 'SW1A', unit: '1AA', label: 'SW1A 1AA' })
        expect(recognisePostcode('W1A1AA', null)).toEqual({ country: 'gb', district: 'W1A', unit: '1AA', label: 'W1A 1AA' })
    })

    it('is a UK district on its own, which finds its middle', () => {
        expect(recognisePostcode('PO30', null)).toEqual({ country: 'gb', district: 'PO30', unit: null, label: 'PO30' })
        expect(recognisePostcode('m1', null)).toEqual({ country: 'gb', district: 'M1', unit: null, label: 'M1' })
    })

    it('is a Northern Ireland postcode, recognised so the person can be told it is not included', () => {
        expect(recognisePostcode('BT1 1AA', 'GB')).toEqual({ country: 'northern-ireland', label: 'BT1 1AA' })
        expect(recognisePostcode('bt7', null)).toEqual({ country: 'northern-ireland', label: 'BT7' })
    })

    it('is a ZIP+4 anywhere, and five digits only where the browser’s region is the United States', () => {
        expect(recognisePostcode('90210-1234', 'GB')).toEqual({ country: 'us', zip: '90210', label: '90210-1234' })
        expect(recognisePostcode('90210 1234', null)).toEqual({ country: 'us', zip: '90210', label: '90210-1234' })
        expect(recognisePostcode('90210', 'US')).toEqual({ country: 'us', zip: '90210', label: '90210' })
        // Five digits is a postcode in 56 regions, Germany's and France's among them.
        expect(recognisePostcode('90210', 'GB')).toBeNull()
        expect(recognisePostcode('10115', 'DE')).toBeNull()
        expect(recognisePostcode('10115', null)).toBeNull()
    })

    it('is nothing else: a name, coordinates, a longer number', () => {
        for (const typed of ['Ventnor', 'Seal Bay', '50.7, -1.3', '123456', 'PO30 1AB Newport', 'A']) {
            expect(recognisePostcode(typed, 'US')).toBeNull()
        }
    })

    it('reads the browser’s region from its language, only where the language names one', () => {
        expect(regionOf('en-US')).toBe('US')
        expect(regionOf('en-GB')).toBe('GB')
        expect(regionOf('en')).toBeNull()
        expect(regionOf('not a language')).toBeNull()
    })
})

describe('where the postcode files are', () => {
    it('is EtherPK’s map host unless the deployment names another, or none', () => {
        expect(postcodesUrl(undefined, false)).toBe('https://maps.etherpk.com/postcodes')
        expect(postcodesUrl(' https://maps.example.org/postcodes/ ')).toBe('https://maps.example.org/postcodes')
        expect(postcodesUrl('')).toBeNull()
        expect(postcodesUrl('not a url')).toBeNull()
    })

    it('is the locally built set in development, unless the deployment names another', () => {
        expect(postcodesUrl(undefined, true)).toBe('/dev-postcodes')
        expect(postcodesUrl('https://maps.example.org/postcodes', true)).toBe('https://maps.example.org/postcodes')
        expect(postcodesUrl('', true)).toBeNull()
    })
})

/** A host serving the given files, counting what was asked of it. */
function host(files: Record<string, unknown>, broken = false) {
    const asked: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        asked.push(url)
        if (broken) throw new TypeError('Failed to fetch')
        const path = url.replace('https://maps.example.org/postcodes/', '')
        return path in files ? new Response(JSON.stringify(files[path]), { status: 200 }) : new Response('Not found', { status: 404 })
    })
    return { fetcher: fetcher as unknown as typeof fetch, asked }
}

const MANIFEST = { format: 1, set: '2026-08', countries: { gb: { files: 1 }, us: { files: 1 } } }
const FILES = {
    'manifest.json': MANIFEST,
    '2026-08/gb/PO30.json': { format: 1, district: 'PO30', centre: [50.69078, -1.31396], area: 0, areas: ['Isle of Wight'], postcodes: { '1AE': [50.69385, -1.29652, 0] } },
    '2026-08/us/902.json': { format: 1, prefix: '902', areas: ['Los Angeles County, CA'], postcodes: { 10: [34.10053, -118.41463, 0] } },
}

describe('the place the files give', () => {
    it('is the postcode’s point, named with the postcode, its council area under it', async () => {
        const { fetcher } = host(FILES)
        const lookup = createPostcodeLookup('https://maps.example.org/postcodes', fetcher)
        expect(await lookup.find({ country: 'gb', district: 'PO30', unit: '1AE', label: 'PO30 1AE' })).toEqual({
            name: 'PO30 1AE',
            detail: 'Isle of Wight',
            point: { lat: 50.69385, lon: -1.29652 },
            postcode: 'PO30 1AE',
        })
    })

    it('is the district’s middle for a district on its own', async () => {
        const lookup = createPostcodeLookup('https://maps.example.org/postcodes', host(FILES).fetcher)
        expect(await lookup.find({ country: 'gb', district: 'PO30', unit: null, label: 'PO30' })).toEqual({ name: 'PO30', detail: 'Isle of Wight', point: { lat: 50.69078, lon: -1.31396 } })
    })

    it('is a ZIP code’s point, named with its five digits, its county under it', async () => {
        const lookup = createPostcodeLookup('https://maps.example.org/postcodes', host(FILES).fetcher)
        expect(await lookup.find({ country: 'us', zip: '90210', label: '90210-1234' })).toEqual({
            name: '90210',
            detail: 'Los Angeles County, CA',
            point: { lat: 34.10053, lon: -118.41463 },
            postcode: '90210',
        })
    })

    it('is nothing for a postcode the files do not hold, a district they do not have, or a country they leave out', async () => {
        const lookup = createPostcodeLookup('https://maps.example.org/postcodes', host({ ...FILES, 'manifest.json': { ...MANIFEST, countries: { gb: {} } } }).fetcher)
        expect(await lookup.find({ country: 'gb', district: 'PO30', unit: '9ZZ', label: 'PO30 9ZZ' })).toBeNull()
        expect(await lookup.find({ country: 'gb', district: 'GY1', unit: '1AA', label: 'GY1 1AA' })).toBeNull()
        expect(await lookup.find({ country: 'us', zip: '90210', label: '90210' })).toBeNull()
    })

    it('reads the manifest and each file once a session', async () => {
        const { fetcher, asked } = host(FILES)
        const lookup = createPostcodeLookup('https://maps.example.org/postcodes', fetcher)
        await lookup.find({ country: 'gb', district: 'PO30', unit: '1AE', label: 'PO30 1AE' })
        await lookup.find({ country: 'gb', district: 'PO30', unit: null, label: 'PO30' })
        expect(asked).toEqual(['https://maps.example.org/postcodes/manifest.json', 'https://maps.example.org/postcodes/2026-08/gb/PO30.json'])
    })

    it('says so when the files cannot be reached, and tries again at the next search', async () => {
        const broken = host(FILES, true)
        const lookup = createPostcodeLookup('https://maps.example.org/postcodes', broken.fetcher)
        await expect(lookup.find({ country: 'gb', district: 'PO30', unit: '1AE', label: 'PO30 1AE' })).rejects.toThrow("The postcode lookup didn't answer")
        await expect(lookup.find({ country: 'gb', district: 'PO30', unit: '1AE', label: 'PO30 1AE' })).rejects.toThrow("The postcode lookup didn't answer")
        expect(broken.asked).toHaveLength(2)
    })

    it('says to update the app when the files are a newer kind than it reads', async () => {
        const lookup = createPostcodeLookup('https://maps.example.org/postcodes', host({ ...FILES, 'manifest.json': { ...MANIFEST, format: 2 } }).fetcher)
        await expect(lookup.find({ country: 'gb', district: 'PO30', unit: '1AE', label: 'PO30 1AE' })).rejects.toThrow('newer than this app reads')
    })
})
