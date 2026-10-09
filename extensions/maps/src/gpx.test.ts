import { describe, expect, it } from 'vitest'

import { readGpx } from './gpx'

// A GPX recording or plan read into routes and places (ADR 0118): every track and route becomes a
// Route, every waypoint a Place, so nothing the file held is dropped on the way in.

const gpx = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Test" xmlns="http://www.topografix.com/GPX/1/1">
${body}
</gpx>`

describe('reading a GPX file', () => {
    it('reads a track, its segments joined in order, with its name', () => {
        const file = gpx(`<trk><name>Coast &amp; cliffs</name>
  <trkseg><trkpt lat="50.1" lon="-1.1"><ele>12</ele><time>2026-07-14T09:00:00Z</time></trkpt><trkpt lat="50.2" lon="-1.2"/></trkseg>
  <trkseg><trkpt lon="-1.3" lat="50.3"></trkpt></trkseg>
</trk>`)
        expect(readGpx(file)).toEqual({
            routes: [{ name: 'Coast & cliffs', points: [{ lat: 50.1, lon: -1.1 }, { lat: 50.2, lon: -1.2 }, { lat: 50.3, lon: -1.3 }] }],
            places: [],
        })
    })

    it('reads a planned route and waypoints', () => {
        const file = gpx(`<wpt lat="50.5" lon="-1.5"><name>Car park</name></wpt>
<rte><name>Plan</name><rtept lat="50.5" lon="-1.5"/><rtept lat="50.6" lon="-1.6"/></rte>`)
        expect(readGpx(file)).toEqual({
            routes: [{ name: 'Plan', points: [{ lat: 50.5, lon: -1.5 }, { lat: 50.6, lon: -1.6 }] }],
            places: [{ name: 'Car park', point: { lat: 50.5, lon: -1.5 } }],
        })
    })

    it('leaves out a track with fewer than two points, and points off the earth', () => {
        const file = gpx(`<trk><trkseg><trkpt lat="50" lon="-1"/><trkpt lat="95" lon="-1"/></trkseg></trk>`)
        expect(readGpx(file).routes).toEqual([])
    })

    it('reads a track with no name as unnamed, for the caller to name after the file', () => {
        const file = gpx(`<trk><trkseg><trkpt lat="50" lon="-1"/><trkpt lat="51" lon="-1"/></trkseg></trk>`)
        expect(readGpx(file).routes[0].name).toBe('')
    })

    it('refuses what is not a GPX file', () => {
        expect(() => readGpx('<html><body>nope</body></html>')).toThrow(/GPX/)
    })
})
