import { describe, expect, it } from 'vitest'

import { formatMapPoint, readMapBody, readMapLine, writeMapPlace, writeMapRoute, mapAltText } from './map-text'

// A Map Block keeps its places and routes as lines of text inside its own fence (ADR 0118): one
// line per item, latitude first, `>` joining a route's points. Every line reads on its own, so a
// merge of two members' edits always still reads, and a line that does not read is kept as written.

describe('reading one line', () => {
    it('reads a place: a name, then the last " @ ", then latitude and longitude', () => {
        expect(readMapLine('Seal Bay Campsite @ 50.74860, -1.07890')).toEqual({
            kind: 'place',
            name: 'Seal Bay Campsite',
            point: { lat: 50.7486, lon: -1.0789 },
        })
    })

    it('reads a route: two or more points joined by ">"', () => {
        expect(readMapLine('Coast walk @ 50.7486, -1.0789 > 50.75112, -1.0824 > 50.753, -1.09')).toEqual({
            kind: 'route',
            name: 'Coast walk',
            points: [
                { lat: 50.7486, lon: -1.0789 },
                { lat: 50.75112, lon: -1.0824 },
                { lat: 50.753, lon: -1.09 },
            ],
            track: null,
        })
    })

    it('reads the original recording a route was imported from, in brackets at the end', () => {
        const line = 'Ridge walk @ 54.6012, -3.1341 > 54.605, -3.14 (../assets/ridge-walk.a1b2c3d4.gpx)'
        expect(readMapLine(line)).toMatchObject({ kind: 'route', name: 'Ridge walk', track: '../assets/ridge-walk.a1b2c3d4.gpx' })
    })

    it('splits at the last "@", so a name may hold one', () => {
        expect(readMapLine('Meet @ the pub @ 50.1, -1.2')).toMatchObject({ name: 'Meet @ the pub', point: { lat: 50.1, lon: -1.2 } })
        expect(readMapLine('Look @ 50, 1 @ 51, -1')).toMatchObject({ name: 'Look @ 50, 1', point: { lat: 51, lon: -1 } })
    })

    it('keeps brackets that belong to a place name', () => {
        expect(readMapLine('Pub (closed Mondays) @ 50.1, -1.2')).toMatchObject({ kind: 'place', name: 'Pub (closed Mondays)' })
    })

    it('is lenient about spacing and signs, as hand-written and pasted lines are', () => {
        expect(readMapLine('Pub@50.1,-1.2')).toMatchObject({ name: 'Pub', point: { lat: 50.1, lon: -1.2 } })
        expect(readMapLine('  Pub  @  +50.1 ,  -1.2  ')).toMatchObject({ name: 'Pub', point: { lat: 50.1, lon: -1.2 } })
        expect(readMapLine('Walk @ 50,-1>51,-2')).toMatchObject({ kind: 'route', points: [{ lat: 50, lon: -1 }, { lat: 51, lon: -2 }] })
    })

    it('reads a line of bare coordinates as an item with no name', () => {
        expect(readMapLine('50.1, -1.2')).toEqual({ kind: 'place', name: '', point: { lat: 50.1, lon: -1.2 } })
        expect(readMapLine('@ 50.1, -1.2')).toEqual({ kind: 'place', name: '', point: { lat: 50.1, lon: -1.2 } })
    })

    it('refuses what is not a place or a route', () => {
        expect(readMapLine('Seal Bay')).toBeNull()
        expect(readMapLine('Seal Bay @')).toBeNull()
        expect(readMapLine('Seal Bay @ 50')).toBeNull()
        expect(readMapLine('Seal Bay @ 50, -1 >')).toBeNull()
        expect(readMapLine('Seal Bay @ 50, -1 > > 51, -1')).toBeNull()
        expect(readMapLine('Seal Bay @ 50, -1, 3')).toBeNull()
        expect(readMapLine('Seal Bay @ 1e3, 2')).toBeNull()
    })

    it('refuses a latitude or longitude off the earth', () => {
        expect(readMapLine('North @ 90, 0')).not.toBeNull()
        expect(readMapLine('Too far @ 90.5, 0')).toBeNull()
        expect(readMapLine('Too far @ 0, 180.1')).toBeNull()
        expect(readMapLine('Date line @ 0, -180')).not.toBeNull()
    })

    it('refuses a recording on a single point, which is a place and records nothing', () => {
        expect(readMapLine('Pub @ 50.1, -1.2 (../assets/x.gpx)')).toBeNull()
    })
})

describe('reading a whole body', () => {
    it('numbers each item by its line, skips blank lines and keeps the lines it could not read', () => {
        const body = readMapBody(['Seal Bay @ 50.7486, -1.0789', '', 'not a place', '  ', 'Walk @ 50, -1 > 51, -1'])
        expect(body.items.map((item) => [item.line, item.name])).toEqual([
            [0, 'Seal Bay'],
            [4, 'Walk'],
        ])
        expect(body.unread).toEqual([{ line: 2, text: 'not a place' }])
    })

    it('reads an empty body as no items', () => {
        expect(readMapBody([])).toEqual({ items: [], unread: [] })
    })
})

describe('writing', () => {
    it('writes five decimal places, about a metre', () => {
        expect(formatMapPoint({ lat: 50.123456, lon: -1.0789 })).toBe('50.12346, -1.07890')
        expect(formatMapPoint({ lat: -0.000001, lon: 0 })).toBe('0.00000, 0.00000')
    })

    it('brings a longitude from a map that has wrapped round the world back between -180 and 180', () => {
        expect(formatMapPoint({ lat: 10, lon: 181 })).toBe('10.00000, -179.00000')
        expect(formatMapPoint({ lat: 10, lon: -540 })).toBe('10.00000, -180.00000')
    })

    it('writes a place and a route that read back as written', () => {
        const place = writeMapPlace('Seal Bay Campsite', { lat: 50.7486, lon: -1.0789 })
        expect(place).toBe('Seal Bay Campsite @ 50.74860, -1.07890')
        expect(readMapLine(place)).toMatchObject({ kind: 'place', name: 'Seal Bay Campsite' })

        const route = writeMapRoute('Coast walk', [{ lat: 50.7486, lon: -1.0789 }, { lat: 50.75, lon: -1.08 }], '../assets/walk.gpx')
        expect(route).toBe('Coast walk @ 50.74860, -1.07890 > 50.75000, -1.08000 (../assets/walk.gpx)')
        expect(readMapLine(route)).toMatchObject({ kind: 'route', name: 'Coast walk', track: '../assets/walk.gpx' })
    })

    it('writes a nameless item as its coordinates alone', () => {
        expect(writeMapPlace('  ', { lat: 1, lon: 2 })).toBe('1.00000, 2.00000')
    })

    it('keeps a name on one line, whatever was typed or pasted into it', () => {
        expect(writeMapPlace(' Seal\nBay \t Campsite ', { lat: 1, lon: 2 })).toBe('Seal Bay Campsite @ 1.00000, 2.00000')
    })

    it('refuses a route with fewer than two points', () => {
        expect(() => writeMapRoute('Walk', [{ lat: 1, lon: 2 }])).toThrow(/two points/)
    })
})

// A published Map Block is a picture (ADR 0118): its alt text names what is on it, never where.
describe('the words for a picture of a map', () => {
    it('names its places and routes', () => {
        expect(mapAltText(['Seal Bay @ 50.7486, -1.0789'])).toBe('Map of Seal Bay')
        expect(mapAltText(['Seal Bay @ 50.7, -1.0', 'Coast walk @ 50.7, -1.0 > 50.8, -1.1'])).toBe('Map of Seal Bay and Coast walk')
        expect(mapAltText(['A @ 1, 2', 'B @ 1, 2', 'C @ 1, 2'])).toBe('Map of A, B and C')
    })

    it('counts what has no name, and what is past the first ten', () => {
        expect(mapAltText(['Seal Bay @ 1, 2', '@ 3, 4', '@ 5, 6'])).toBe('Map of Seal Bay and 2 unnamed places')
        expect(mapAltText(['@ 1, 2 > 3, 4'])).toBe('Map of 1 unnamed route')
        const many = Array.from({ length: 13 }, (_, i) => `Place ${i + 1} @ 1, 2`)
        expect(mapAltText(many)).toBe('Map of Place 1, Place 2, Place 3, Place 4, Place 5, Place 6, Place 7, Place 8, Place 9, Place 10 and 3 more')
    })

    it('says a map with nothing on it is empty, and never holds a coordinate', () => {
        expect(mapAltText([])).toBe('An empty map')
        expect(mapAltText(['not a place'])).toBe('An empty map')
        expect(mapAltText(['Seal Bay @ 50.7486, -1.0789'])).not.toMatch(/\d/)
    })
})
