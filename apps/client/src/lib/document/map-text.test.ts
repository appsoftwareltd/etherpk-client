import { describe, expect, it } from 'vitest'

import { formatMapPoint, mapSizeEdits, mapSizeOf, readMapBody, readMapLine, readMapSize, writeMapPlace, writeMapRoute, writeMapSize, mapAltText } from './map-text'

// A Map Block keeps its places and routes as lines of text inside its own fence (ADR 0118): one
// line per item, latitude first, `>` joining a route's points. Every line reads on its own, so a
// merge of two members' edits always still reads, and a line that does not read is kept as written.

describe('reading one line', () => {
    it('reads a place: a name, then the last " @ ", then latitude and longitude', () => {
        expect(readMapLine('Pebble Cove Campsite @ 50.74860, -4.07890')).toEqual({
            kind: 'place',
            name: 'Pebble Cove Campsite',
            point: { lat: 50.7486, lon: -4.0789 },
        })
    })

    it('reads a route: two or more points joined by ">"', () => {
        expect(readMapLine('Coast walk @ 50.7486, -4.0789 > 50.75112, -4.0824 > 50.753, -4.09')).toEqual({
            kind: 'route',
            name: 'Coast walk',
            points: [
                { lat: 50.7486, lon: -4.0789 },
                { lat: 50.75112, lon: -4.0824 },
                { lat: 50.753, lon: -4.09 },
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
        expect(readMapLine(`${'Garden @ '.repeat(100)}50.1, -1.2`)).toMatchObject({ point: { lat: 50.1, lon: -1.2 } })
    })

    // Each "@" tried reads the rest of the line, so a line of thousands would be read thousands of
    // times over. Only the last few can end a name: the one before the place, and any in a recording.
    it('gives up on a line after the last sixteen "@"s, however long it is', () => {
        expect(readMapLine('@1'.repeat(200_000))).toBeNull()
        expect(readMapLine(`Ride @ 50, -1 > 51, -2 (${'ride@'.repeat(16)}.gpx)`)).toBeNull()
        expect(readMapLine(`Ride @ 50, -1 > 51, -2 (${'ride@'.repeat(15)}.gpx)`)).toMatchObject({ kind: 'route', name: 'Ride' })
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
        expect(readMapLine('Pebble Cove')).toBeNull()
        expect(readMapLine('Pebble Cove @')).toBeNull()
        expect(readMapLine('Pebble Cove @ 50')).toBeNull()
        expect(readMapLine('Pebble Cove @ 50, -1 >')).toBeNull()
        expect(readMapLine('Pebble Cove @ 50, -1 > > 51, -1')).toBeNull()
        expect(readMapLine('Pebble Cove @ 50, -1, 3')).toBeNull()
        expect(readMapLine('Pebble Cove @ 1e3, 2')).toBeNull()
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
        const body = readMapBody(['Pebble Cove @ 50.7486, -4.0789', '', 'not a place', '  ', 'Walk @ 50, -1 > 51, -1'])
        expect(body.items.map((item) => [item.line, item.name])).toEqual([
            [0, 'Pebble Cove'],
            [4, 'Walk'],
        ])
        expect(body.unread).toEqual([{ line: 2, text: 'not a place' }])
    })

    it('reads an empty body as no items', () => {
        expect(readMapBody([])).toEqual({ items: [], unread: [], size: null })
    })
})

describe('a size line', () => {
    it('reads a width and a height in CSS pixels', () => {
        expect(readMapSize('size 640x380')).toEqual({ width: 640, height: 380 })
    })

    it('reads a height alone, for a map that fills its column', () => {
        expect(readMapSize('size x500')).toEqual({ width: null, height: 500 })
    })

    it('is lenient about spacing, as a hand-written line is', () => {
        expect(readMapSize('  size   640x380  ')).toEqual({ width: 640, height: 380 })
    })

    it('refuses anything else', () => {
        for (const text of ['size', 'size 640', 'size x', 'size 0x100', 'size 640x0', 'size x0', 'Size 640x380', 'size 640X380', 'size 640 x 380', 'size 640x380 wide', 'size -640x380', 'size 123456x100']) {
            expect(readMapSize(text), text).toBeNull()
        }
    })

    it('is the map’s size wherever it sits, and is neither an item nor an unread line', () => {
        const body = readMapBody(['Garden @ 50.7486, -4.0789', 'size 640x380'])
        expect(body.size).toEqual({ width: 640, height: 380 })
        expect(body.items.map((item) => item.name)).toEqual(['Garden'])
        expect(body.unread).toEqual([])
    })

    it('reports a second size line and one that does not read, both kept as written', () => {
        const body = readMapBody(['size 640x380', 'size 700x400', 'size 640'])
        expect(body.size).toEqual({ width: 640, height: 380 })
        expect(body.unread).toEqual([
            { line: 1, text: 'size 700x400' },
            { line: 2, text: 'size 640' },
        ])
    })

    it('reads a line that says where a place is as that place, whatever its name', () => {
        const body = readMapBody(['size 640x380 @ 50.74860, -4.07890'])
        expect(body.size).toBeNull()
        expect(body.items.map((item) => item.name)).toEqual(['size 640x380'])
    })

    it('is found in a body without reading its places and routes', () => {
        expect(mapSizeOf(['Garden @ 50.7486, -4.0789', 'size 640', 'size x500', 'size 640x380'])).toEqual({ width: null, height: 500 })
        expect(mapSizeOf(['Garden @ 50.7486, -4.0789'])).toBeNull()
    })

    it('writes what it reads back', () => {
        expect(writeMapSize({ width: 640, height: 380 })).toBe('size 640x380')
        expect(writeMapSize({ width: null, height: 500 })).toBe('size x500')
        expect(readMapSize(writeMapSize({ width: null, height: 500 }))).toEqual({ width: null, height: 500 })
    })

    it('leaves the words for a picture of the map alone', () => {
        expect(mapAltText(['size 640x380', 'Garden @ 50.7486, -4.0789'])).toBe('Map of Garden')
        expect(mapAltText(['size 640x380'])).toBe('An empty map')
    })
})

describe('the line changes that write a size', () => {
    const garden = 'Garden @ 50.74860, -4.07890'
    const size = { width: 640, height: 380 }

    it('puts the line first in a map that has none', () => {
        expect(mapSizeEdits([garden], size)).toEqual([{ kind: 'insert', line: 0, text: 'size 640x380' }])
        expect(mapSizeEdits([], size)).toEqual([{ kind: 'insert', line: 0, text: 'size 640x380' }])
    })

    it('changes the line where it is', () => {
        expect(mapSizeEdits([garden, 'size x500'], size)).toEqual([{ kind: 'replace', line: 1, expect: 'size x500', text: 'size 640x380' }])
    })

    it('changes nothing when the line already says it', () => {
        expect(mapSizeEdits(['size 640x380', garden], size)).toEqual([])
    })

    it('takes away what a merge left, last first, so each removal leaves the lines before it in place', () => {
        expect(mapSizeEdits(['size 700x400', garden, 'size 500x300', 'size 600x300'], size)).toEqual([
            { kind: 'replace', line: 0, expect: 'size 700x400', text: 'size 640x380' },
            { kind: 'remove', line: 3, expect: 'size 600x300' },
            { kind: 'remove', line: 2, expect: 'size 500x300' },
        ])
    })

    it('removes every size line for no size, and leaves a line that does not read', () => {
        expect(mapSizeEdits(['size 640x380', 'size 640', garden, 'size x500'], null)).toEqual([
            { kind: 'remove', line: 3, expect: 'size x500' },
            { kind: 'remove', line: 0, expect: 'size 640x380' },
        ])
    })

    it('has nothing to remove from a map with no size', () => {
        expect(mapSizeEdits([garden], null)).toEqual([])
    })
})

describe('writing', () => {
    it('writes five decimal places, about a metre', () => {
        expect(formatMapPoint({ lat: 50.123456, lon: -4.0789 })).toBe('50.12346, -4.07890')
        expect(formatMapPoint({ lat: -0.000001, lon: 0 })).toBe('0.00000, 0.00000')
    })

    it('brings a longitude from a map that has wrapped round the world back between -180 and 180', () => {
        expect(formatMapPoint({ lat: 10, lon: 181 })).toBe('10.00000, -179.00000')
        expect(formatMapPoint({ lat: 10, lon: -540 })).toBe('10.00000, -180.00000')
    })

    it('writes a place and a route that read back as written', () => {
        const place = writeMapPlace('Pebble Cove Campsite', { lat: 50.7486, lon: -4.0789 })
        expect(place).toBe('Pebble Cove Campsite @ 50.74860, -4.07890')
        expect(readMapLine(place)).toMatchObject({ kind: 'place', name: 'Pebble Cove Campsite' })

        const route = writeMapRoute('Coast walk', [{ lat: 50.7486, lon: -4.0789 }, { lat: 50.75, lon: -4.08 }], '../assets/walk.gpx')
        expect(route).toBe('Coast walk @ 50.74860, -4.07890 > 50.75000, -4.08000 (../assets/walk.gpx)')
        expect(readMapLine(route)).toMatchObject({ kind: 'route', name: 'Coast walk', track: '../assets/walk.gpx' })
    })

    it('writes a nameless item as its coordinates alone', () => {
        expect(writeMapPlace('  ', { lat: 1, lon: 2 })).toBe('1.00000, 2.00000')
    })

    it('keeps a name on one line, whatever was typed or pasted into it', () => {
        expect(writeMapPlace(' Pebble\nCove \t Campsite ', { lat: 1, lon: 2 })).toBe('Pebble Cove Campsite @ 1.00000, 2.00000')
    })

    it('refuses a route with fewer than two points', () => {
        expect(() => writeMapRoute('Walk', [{ lat: 1, lon: 2 }])).toThrow(/two points/)
    })
})

// A published Map Block is a picture (ADR 0118): its alt text names what is on it, never where.
describe('the words for a picture of a map', () => {
    it('names its places and routes', () => {
        expect(mapAltText(['Pebble Cove @ 50.7486, -4.0789'])).toBe('Map of Pebble Cove')
        expect(mapAltText(['Pebble Cove @ 50.7, -1.0', 'Coast walk @ 50.7, -1.0 > 50.8, -1.1'])).toBe('Map of Pebble Cove and Coast walk')
        expect(mapAltText(['A @ 1, 2', 'B @ 1, 2', 'C @ 1, 2'])).toBe('Map of A, B and C')
    })

    it('counts what has no name, and what is past the first ten', () => {
        expect(mapAltText(['Pebble Cove @ 1, 2', '@ 3, 4', '@ 5, 6'])).toBe('Map of Pebble Cove and 2 unnamed places')
        expect(mapAltText(['@ 1, 2 > 3, 4'])).toBe('Map of 1 unnamed route')
        const many = Array.from({ length: 13 }, (_, i) => `Place ${i + 1} @ 1, 2`)
        expect(mapAltText(many)).toBe('Map of Place 1, Place 2, Place 3, Place 4, Place 5, Place 6, Place 7, Place 8, Place 9, Place 10 and 3 more')
    })

    it('says a map with nothing on it is empty, and never holds a coordinate', () => {
        expect(mapAltText([])).toBe('An empty map')
        expect(mapAltText(['not a place'])).toBe('An empty map')
        expect(mapAltText(['Pebble Cove @ 50.7486, -4.0789'])).not.toMatch(/\d/)
    })
})
