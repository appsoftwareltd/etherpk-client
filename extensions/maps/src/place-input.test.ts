import { describe, expect, it } from 'vitest'

import { decodePlusCode, readPlaceInput, readSearchBox, recoverPlusCode } from './place-input'

// What a person types or pastes into a Map Block's search box is read on the device first
// (ADR 0119): coordinates, Plus Codes and links copied from other maps never leave it, and they
// work for everyone. Only a name, an address or a postcode goes to place search.

const near = (actual: number, expected: number, within = 1e-6) => expect(Math.abs(actual - expected)).toBeLessThan(within)

describe('coordinates', () => {
    it('reads decimal degrees, latitude first, as Google Maps copies them', () => {
        expect(readPlaceInput('50.7486, -4.0789')).toEqual({ point: { lat: 50.7486, lon: -4.0789 }, name: '', from: 'coordinates' })
        expect(readPlaceInput('50.7486,-4.0789')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
        expect(readPlaceInput('  50.7486   -4.0789 ')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
    })

    it('reads hemisphere letters before or after, in either order', () => {
        expect(readPlaceInput('50.7486° N, 4.0789° W')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
        expect(readPlaceInput('N 50.7486 W 4.0789')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
        expect(readPlaceInput('50.7486N 4.0789W')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
        expect(readPlaceInput('4.0789W, 50.7486N')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
        expect(readPlaceInput('33.86 s 151.21 e')?.point).toEqual({ lat: -33.86, lon: 151.21 })
    })

    it('reads degrees, minutes and seconds', () => {
        const dms = readPlaceInput(`50°44'55.0"N 4°04'44.0"W`)?.point
        near(dms!.lat, 50 + 44 / 60 + 55 / 3600)
        near(dms!.lon, -(4 + 4 / 60 + 44 / 3600))
        const primes = readPlaceInput('50°44′55″N, 4°4′44″W')?.point
        near(primes!.lat, 50 + 44 / 60 + 55 / 3600)
        near(primes!.lon, -(4 + 4 / 60 + 44 / 3600))
    })

    it('reads degrees and decimal minutes', () => {
        const ddm = readPlaceInput(`50°44.916'N 4°04.734'W`)?.point
        near(ddm!.lat, 50.7486)
        near(ddm!.lon, -4.0789)
    })

    it('refuses what is not a pair of coordinates on the earth', () => {
        expect(readPlaceInput('Pebble Cove')).toBeNull()
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
            'https://www.google.com/maps/place/Pebble+Cove+Campsite/@50.7486,-4.0789,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d50.74871!4d-4.07902!16s'
        expect(readPlaceInput(link)).toEqual({ point: { lat: 50.74871, lon: -4.07902 }, name: 'Pebble Cove Campsite', from: 'link' })
    })

    it('reads the other Google Maps link forms', () => {
        expect(readPlaceInput('https://www.google.com/maps/@50.7486,-4.0789,15z')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
        expect(readPlaceInput('https://www.google.com/maps/search/?api=1&query=50.7486,-4.0789')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
        expect(readPlaceInput('https://maps.google.co.uk/?q=50.7486,-4.0789')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
        expect(readPlaceInput('https://www.google.com/maps?ll=50.7486,-4.0789&z=12')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
    })

    it('reads Apple Maps links with their names', () => {
        expect(readPlaceInput('https://maps.apple.com/?ll=50.7486,-4.0789&q=Pebble%20Cove')).toEqual({
            point: { lat: 50.7486, lon: -4.0789 },
            name: 'Pebble Cove',
            from: 'link',
        })
        expect(readPlaceInput('https://maps.apple.com/place?coordinate=50.7486,-4.0789&name=Pebble%20Cove')?.name).toBe('Pebble Cove')
    })

    it('reads OpenStreetMap links, preferring the marker over the map centre', () => {
        expect(readPlaceInput('https://www.openstreetmap.org/#map=17/50.74860/-4.07890')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
        expect(readPlaceInput('https://www.openstreetmap.org/?mlat=50.75&mlon=-4.08#map=17/50.74860/-4.07890')?.point).toEqual({ lat: 50.75, lon: -4.08 })
    })

    it('reads geo: links, with an Android label as the name', () => {
        expect(readPlaceInput('geo:50.7486,-4.0789')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
        expect(readPlaceInput('geo:50.7486,-4.0789;u=35')?.point).toEqual({ lat: 50.7486, lon: -4.0789 })
        expect(readPlaceInput('geo:0,0?q=50.7486,-4.0789(Pebble%20Cove)')).toEqual({ point: { lat: 50.7486, lon: -4.0789 }, name: 'Pebble Cove', from: 'link' })
    })

    it('refuses a link that carries no coordinates', () => {
        expect(readPlaceInput('https://www.google.com/maps?q=Pebble+Cove')).toBeNull()
        expect(readPlaceInput('https://maps.apple.com/?address=Pebble%20Cove')).toBeNull()
        expect(readPlaceInput('https://example.com/?q=50.7486,-4.0789')).toBeNull()
        expect(readPlaceInput('https://maps.app.goo.gl/AbCdEf123')).toBeNull()
    })

    // Positions OpenStreetMap's own site gives for these short links, as its /go/ redirect.
    it.each([
        ['https://osm.org/go/0EEQjE--', 51.510772705078125, 0.054931640625],
        ['https://www.openstreetmap.org/go/0EEQjEEb', 51.510998010635376, 0.05499601364135742],
        ['https://osm.org/go/euu4XEhK--?m', 51.5438175201416, -0.16404390335083008],
    ])('decodes the OpenStreetMap short link %s on the device', (link, lat, lon) => {
        const place = readPlaceInput(link)
        expect(place).toMatchObject({ name: '', from: 'link' })
        near(place!.point.lat, lat, 1e-9)
        near(place!.point.lon, lon, 1e-9)
    })

    it('reads a link with a stray % in its name', () => {
        expect(readPlaceInput('https://www.google.com/maps/place/100%+Garden/@50.6,-1.2,17z')).toEqual({ point: { lat: 50.6, lon: -1.2 }, name: '100% Garden', from: 'link' })
    })

    it("gives no name for a dropped pin, whose link names it by its own coordinates", () => {
        const pin = "https://www.google.com/maps/place/50%C2%B044'55.0%22N+4%C2%B004'44.0%22W/@50.7486,-4.0789,17z/data=!3m1!4b1!4m4!3m3!8m2!3d50.74861!4d-4.07889"
        expect(readPlaceInput(pin)).toEqual({ point: { lat: 50.74861, lon: -4.07889 }, name: '', from: 'link' })
    })
})

describe('what the search box holds', () => {
    it('is a place, read on the device, or words to search for', () => {
        expect(readSearchBox(' 50.7486, -4.0789 ')).toEqual({ kind: 'place', place: { point: { lat: 50.7486, lon: -4.0789 }, name: '', from: 'coordinates' } })
        expect(readSearchBox('Garden Centre')).toEqual({ kind: 'words', words: 'Garden Centre' })
    })

    it('is a short link, which the Sync Server opens', () => {
        expect(readSearchBox('https://maps.app.goo.gl/AbCdEf123')).toEqual({ kind: 'short-link', url: 'https://maps.app.goo.gl/AbCdEf123', name: '' })
        expect(readSearchBox('https://goo.gl/maps/AbCdEf123')).toMatchObject({ kind: 'short-link' })
    })

    // A phone's Share gives the place's name before its link. A one-line box joins the lines with a
    // space, or with nothing at all, depending on the browser.
    it.each([
        ['Garden Centre\nhttps://maps.app.goo.gl/AbCdEf123'],
        ['Garden Centre https://maps.app.goo.gl/AbCdEf123'],
        ['Garden Centrehttps://maps.app.goo.gl/AbCdEf123'],
        ['Garden Centre\n1 High Street, Brookmouth\nhttps://maps.app.goo.gl/AbCdEf123'],
    ])('finds the link in shared text, and names the place with the line before it: %j', (text) => {
        expect(readSearchBox(text)).toEqual({ kind: 'short-link', url: 'https://maps.app.goo.gl/AbCdEf123', name: 'Garden Centre' })
    })

    it("prefers a link's own name to the text shared with it", () => {
        const shared = 'Kitchen\nhttps://www.google.com/maps/place/Garden+Centre/@50.6,-1.2,17z'
        expect(readSearchBox(shared)).toEqual({ kind: 'place', place: { point: { lat: 50.6, lon: -1.2 }, name: 'Garden Centre', from: 'link' } })
        expect(readSearchBox('Kitchen\nhttps://www.openstreetmap.org/#map=17/50.6/-1.2')).toMatchObject({ kind: 'place', place: { name: 'Kitchen' } })
    })

    it('is the words of a map link that names a place but does not say where it is', () => {
        expect(readSearchBox('https://www.google.com/maps/place/Garden+Centre/data=!4m2!3m1!1s0x0:0x1')).toEqual({ kind: 'link-words', words: 'Garden Centre', name: 'Garden Centre' })
        // What a phone's short link leads to: the name and the address, and no coordinates.
        expect(readSearchBox('https://maps.google.com/?q=Garden+Centre,+1+High+Street,+Brookmouth&ftid=0x1:0x2&entry=gps')).toEqual({
            kind: 'link-words',
            words: 'Garden Centre, 1 High Street, Brookmouth',
            name: 'Garden Centre',
        })
        expect(readSearchBox('https://www.google.com/maps/search/?api=1&query=Garden+Centre')).toEqual({ kind: 'link-words', words: 'Garden Centre', name: '' })
        expect(readSearchBox('https://www.google.com/maps/search/Garden+Centre/')).toEqual({ kind: 'link-words', words: 'Garden Centre', name: '' })
        expect(readSearchBox('https://maps.apple.com/?q=Garden%20Centre&address=1%20High%20Street,%20Brookmouth')).toEqual({
            kind: 'link-words',
            words: 'Garden Centre, 1 High Street, Brookmouth',
            name: 'Garden Centre',
        })
        expect(readSearchBox('https://www.openstreetmap.org/search?query=Garden%20Centre')).toEqual({ kind: 'link-words', words: 'Garden Centre', name: '' })
    })

    it('is a link nothing can be read from: another site, or a map link that names no place', () => {
        expect(readSearchBox('https://example.com/?q=50.7486,-4.0789')).toEqual({ kind: 'unreadable-link' })
        expect(readSearchBox('https://maps.google.com/?cid=1234567890')).toEqual({ kind: 'unreadable-link' })
        expect(readSearchBox('https://www.openstreetmap.org/node/123')).toEqual({ kind: 'unreadable-link' })
    })
})
