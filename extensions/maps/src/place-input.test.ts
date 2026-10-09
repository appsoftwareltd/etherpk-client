import { describe, expect, it } from 'vitest'

import { decodePlusCode, isShortMapLink, readPlaceInput, recoverPlusCode } from './place-input'

// What a person types or pastes into a Map Block's search box is read on the device first
// (ADR 0119): coordinates, Plus Codes and links copied from other maps never leave it, and they
// work for everyone. Only a name, an address or a postcode goes to place search.

const near = (actual: number, expected: number, within = 1e-6) => expect(Math.abs(actual - expected)).toBeLessThan(within)

describe('coordinates', () => {
    it('reads decimal degrees, latitude first, as Google Maps copies them', () => {
        expect(readPlaceInput('50.7486, -1.0789')).toEqual({ point: { lat: 50.7486, lon: -1.0789 }, name: '', from: 'coordinates' })
        expect(readPlaceInput('50.7486,-1.0789')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
        expect(readPlaceInput('  50.7486   -1.0789 ')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
    })

    it('reads hemisphere letters before or after, in either order', () => {
        expect(readPlaceInput('50.7486° N, 1.0789° W')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
        expect(readPlaceInput('N 50.7486 W 1.0789')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
        expect(readPlaceInput('50.7486N 1.0789W')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
        expect(readPlaceInput('1.0789W, 50.7486N')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
        expect(readPlaceInput('33.86 s 151.21 e')?.point).toEqual({ lat: -33.86, lon: 151.21 })
    })

    it('reads degrees, minutes and seconds', () => {
        const dms = readPlaceInput(`50°44'55.0"N 1°04'44.0"W`)?.point
        near(dms!.lat, 50 + 44 / 60 + 55 / 3600)
        near(dms!.lon, -(1 + 4 / 60 + 44 / 3600))
        const primes = readPlaceInput('50°44′55″N, 1°4′44″W')?.point
        near(primes!.lat, 50 + 44 / 60 + 55 / 3600)
        near(primes!.lon, -(1 + 4 / 60 + 44 / 3600))
    })

    it('reads degrees and decimal minutes', () => {
        const ddm = readPlaceInput(`50°44.916'N 1°04.734'W`)?.point
        near(ddm!.lat, 50.7486)
        near(ddm!.lon, -1.0789)
    })

    it('refuses what is not a pair of coordinates on the earth', () => {
        expect(readPlaceInput('Seal Bay')).toBeNull()
        expect(readPlaceInput('50.7486')).toBeNull()
        expect(readPlaceInput('91, 0')).toBeNull()
        expect(readPlaceInput('50, 200')).toBeNull()
        expect(readPlaceInput('50°61\'N 1°W')).toBeNull()
        expect(readPlaceInput('-50 N, 1 W')).toBeNull()
        expect(readPlaceInput('50 N, 1 S')).toBeNull()
        expect(readPlaceInput('SW1A 1AA')).toBeNull()
    })
})

describe('Plus Codes', () => {
    // Rows from the Open Location Code test data (test_data/decoding.csv): a code decodes to an
    // area, and a place goes at its centre.
    const decoding: [string, number, number, number, number][] = [
        ['7FG49Q00+', 20.35, 2.75, 20.4, 2.8],
        ['7FG49QCJ+2V', 20.37, 2.782125, 20.370125, 2.78225],
        ['7FG49QCJ+2VX', 20.3701, 2.78221875, 20.370125, 2.78225],
        ['8FVC2222+22', 47.0, 8.0, 47.000125, 8.000125],
        ['4VCPPQGP+Q9', -41.273125, 174.785875, -41.273, 174.786],
        ['62G20000+', 0.0, -180.0, 1, -179],
        ['22222222+22', -90.0, -180.0, -89.999875, -179.999875],
        ['CFX3X2X2+X2', 89.999875, 1, 90, 1.000125],
        ['55CJG366+PP', -21.48825, -107.93825, -21.488125, -107.938125],
    ]
    it.each(decoding)('decodes %s to the centre of its area', (code, latLo, lngLo, latHi, lngHi) => {
        const point = decodePlusCode(code)
        near(point!.lat, (latLo + latHi) / 2, 1e-9)
        near(point!.lon, (lngLo + lngHi) / 2, 1e-9)
    })

    it('reads a full code typed into the search box, in any case', () => {
        expect(readPlaceInput('8fvc2222+22')).toMatchObject({ from: 'plus-code', name: '' })
    })

    // Rows from test_data/shortCodeTests.csv: a short code is recovered nearest to a reference,
    // here the centre of the map being looked at.
    const recovery: [string, number, number, string][] = [
        ['+2VX', 51.3701125, -1.217765625, '9C3W9QCJ+2VX'],
        ['CJ+2VX', 51.3708675, -1.217765625, '9C3W9QCJ+2VX'],
        ['9QCJ+2VX', 51.3550125, -1.217765625, '9C3W9QCJ+2VX'],
        ['22+', 42.899, 9.012, '8FJFW222+'],
        ['2222+22', 89.6, 0.0, 'CFX22222+22'],
        ['XXXXXX+XX', -81.0, 0.0, '2CXXXXXX+XX'],
        ['8frCG2GG+gG', 46.526, 7.976, '8FRCG2GG+GG'],
    ]
    it.each(recovery)('recovers %s near (%f, %f)', (short, lat, lon, full) => {
        const recovered = recoverPlusCode(short, { lat, lon })
        const expected = decodePlusCode(full)!
        near(recovered!.lat, expected.lat, 1e-9)
        near(recovered!.lon, expected.lon, 1e-9)
    })

    it('reads a short code only beside a map to recover it near', () => {
        expect(readPlaceInput('9QCJ+2VX')).toBeNull()
        expect(readPlaceInput('9QCJ+2VX', { lat: 51.37, lon: -1.22 })).toMatchObject({ from: 'plus-code' })
        // A town after a short code needs a search; nothing on the device can find the town.
        expect(readPlaceInput('9QCJ+2VX Newbury', { lat: 51.37, lon: -1.22 })).toBeNull()
    })

    it('refuses what is not a Plus Code', () => {
        expect(decodePlusCode('7FG49QCJ2V')).toBeNull()
        expect(decodePlusCode('7FG49QCJ+2')).toBeNull()
        expect(decodePlusCode('7FG4AQCJ+2V')).toBeNull()
        expect(decodePlusCode('ZZ000000+')).toBeNull()
    })
})

describe('links copied from other maps', () => {
    it('reads a Google Maps place link, preferring the place over the map centre, and its name', () => {
        const link =
            'https://www.google.com/maps/place/Seal+Bay+Campsite/@50.7486,-1.0789,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d50.74871!4d-1.07902!16s'
        expect(readPlaceInput(link)).toEqual({ point: { lat: 50.74871, lon: -1.07902 }, name: 'Seal Bay Campsite', from: 'link' })
    })

    it('reads the other Google Maps link forms', () => {
        expect(readPlaceInput('https://www.google.com/maps/@50.7486,-1.0789,15z')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
        expect(readPlaceInput('https://www.google.com/maps/search/?api=1&query=50.7486,-1.0789')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
        expect(readPlaceInput('https://maps.google.co.uk/?q=50.7486,-1.0789')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
        expect(readPlaceInput('https://www.google.com/maps?ll=50.7486,-1.0789&z=12')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
    })

    it('reads Apple Maps links with their names', () => {
        expect(readPlaceInput('https://maps.apple.com/?ll=50.7486,-1.0789&q=Seal%20Bay')).toEqual({
            point: { lat: 50.7486, lon: -1.0789 },
            name: 'Seal Bay',
            from: 'link',
        })
        expect(readPlaceInput('https://maps.apple.com/place?coordinate=50.7486,-1.0789&name=Seal%20Bay')?.name).toBe('Seal Bay')
    })

    it('reads OpenStreetMap links, preferring the marker over the map centre', () => {
        expect(readPlaceInput('https://www.openstreetmap.org/#map=17/50.74860/-1.07890')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
        expect(readPlaceInput('https://www.openstreetmap.org/?mlat=50.75&mlon=-1.08#map=17/50.74860/-1.07890')?.point).toEqual({ lat: 50.75, lon: -1.08 })
    })

    it('reads geo: links, with an Android label as the name', () => {
        expect(readPlaceInput('geo:50.7486,-1.0789')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
        expect(readPlaceInput('geo:50.7486,-1.0789;u=35')?.point).toEqual({ lat: 50.7486, lon: -1.0789 })
        expect(readPlaceInput('geo:0,0?q=50.7486,-1.0789(Seal%20Bay)')).toEqual({ point: { lat: 50.7486, lon: -1.0789 }, name: 'Seal Bay', from: 'link' })
    })

    it('refuses a link that carries no coordinates', () => {
        expect(readPlaceInput('https://www.google.com/maps?q=Seal+Bay')).toBeNull()
        expect(readPlaceInput('https://maps.apple.com/?address=Seal%20Bay')).toBeNull()
        expect(readPlaceInput('https://example.com/?q=50.7486,-1.0789')).toBeNull()
    })

    it('knows a short link, which has to be opened before its place can be read', () => {
        expect(isShortMapLink('https://maps.app.goo.gl/AbCdEf123')).toBe(true)
        expect(isShortMapLink('https://goo.gl/maps/AbCdEf123')).toBe(true)
        expect(isShortMapLink('https://osm.org/go/euu4XEhK--')).toBe(true)
        expect(isShortMapLink('https://www.google.com/maps/@50.7486,-1.0789,15z')).toBe(false)
        expect(readPlaceInput('https://maps.app.goo.gl/AbCdEf123')).toBeNull()
    })
})
