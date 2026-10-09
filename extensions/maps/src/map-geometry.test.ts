import { describe, expect, it } from 'vitest'

import type { MapLine } from '$lib/document/map-text'

import { formatDistance, haversineMeters, itemsBounds, oneSpotAt, placesAtSpot, routeLengthMeters, simplifyPath, worldPixels } from './map-geometry'

// The arithmetic a map needs on the device: what to frame, how long a route is, and how a
// recorded track is thinned to a line that still lies within a few metres of the original.

const place = (lat: number, lon: number): MapLine => ({ kind: 'place', name: '', point: { lat, lon } })
const route = (...points: [number, number][]): MapLine => ({ kind: 'route', name: '', points: points.map(([lat, lon]) => ({ lat, lon })), track: null })

describe('what a map frames', () => {
    it('is nothing for no items', () => {
        expect(itemsBounds([])).toBeNull()
    })

    it('covers every place and every point of every route', () => {
        expect(itemsBounds([place(50, -1), route([51, -2], [49.5, 0.5])])).toEqual({ west: -2, south: 49.5, east: 0.5, north: 51 })
    })

    it('is a single point for a single place, which the map frames at a capped zoom', () => {
        expect(itemsBounds([place(50, -1)])).toEqual({ west: -1, south: 50, east: -1, north: 50 })
    })

    it('frames a whole graph of long routes without running out of stack', () => {
        // A Map View draws every route in a graph at once: thousands of routes of up to 2,000
        // points each. Spreading that many numbers into Math.min throws a RangeError.
        const long = route(...Array.from({ length: 2000 }, (_, i): [number, number] => [50 + i / 10_000, -1 - i / 10_000]))
        const graph = Array.from({ length: 300 }, () => long)
        expect(itemsBounds(graph)).toEqual({ west: -1.1999, south: 50, east: -1, north: 50.1999 })
    })

    it('frames across the date line the short way round', () => {
        // Fiji and Samoa: the long way round is most of the world.
        expect(itemsBounds([place(-17.7, 178.1), place(-13.8, -171.8)])).toEqual({ west: 178.1, south: -17.7, east: 188.2, north: -13.8 })
    })
})

describe('distances', () => {
    it('measures along the earth', () => {
        // London to Paris, about 344 km.
        expect(haversineMeters({ lat: 51.5074, lon: -0.1278 }, { lat: 48.8566, lon: 2.3522 }) / 1000).toBeCloseTo(343.6, 0)
    })

    it('adds a route up point by point', () => {
        const legs = [
            { lat: 50, lon: 0 },
            { lat: 50.01, lon: 0 },
            { lat: 50.02, lon: 0 },
        ]
        expect(routeLengthMeters(legs)).toBeCloseTo(2 * haversineMeters(legs[0], legs[1]), 3)
    })

    it('reads in metres under a kilometre, and in kilometres and miles above', () => {
        expect(formatDistance(850)).toBe('850 m')
        expect(formatDistance(12_400)).toBe('12.4 km (7.7 mi)')
        expect(formatDistance(250_000)).toBe('250 km (155 mi)')
    })
})

describe('thinning a recorded track', () => {
    it('keeps the ends and drops points that lie on the line between their neighbours', () => {
        const straight = Array.from({ length: 50 }, (_, i) => ({ lat: 50 + i * 0.0001, lon: 0 }))
        expect(simplifyPath(straight, 5)).toEqual([straight[0], straight[49]])
    })

    it('keeps a corner', () => {
        const corner = [
            { lat: 50, lon: 0 },
            { lat: 50.001, lon: 0 },
            { lat: 50.002, lon: 0 },
            { lat: 50.002, lon: 0.002 },
        ]
        expect(simplifyPath(corner, 5)).toEqual([corner[0], corner[2], corner[3]])
    })

    it('leaves short paths alone', () => {
        const two = [
            { lat: 50, lon: 0 },
            { lat: 51, lon: 1 },
        ]
        expect(simplifyPath(two, 5)).toEqual(two)
    })
})

describe('places that share a spot on screen', () => {
    it('finds a point on the world as MapLibre draws it, twice as far apart at each zoom in', () => {
        expect(worldPixels({ lat: 0, lon: 0 }, 0)).toEqual({ x: 256, y: 256 })
        expect(worldPixels({ lat: 0, lon: 180 }, 1)).toEqual({ x: 1024, y: 512 })
        expect(worldPixels({ lat: 50, lon: 0 }, 0).y).toBeLessThan(256)
        const apart = (zoom: number) => worldPixels({ lat: 50.7, lon: -1.5 }, zoom).x - worldPixels({ lat: 50.7, lon: -1.6 }, zoom).x
        expect(apart(14)).toBeCloseTo(apart(13) * 2, 6)
    })

    it('takes in every pin within half a pin of the chosen one, the chosen one too, in the order given', () => {
        const points = new Map([
            [1, { x: 0, y: 0 }],
            [2, { x: 5, y: 5 }],
            [3, { x: 30, y: 0 }],
            [4, { x: 12, y: 0 }],
        ])
        expect(placesAtSpot(points, 1)).toEqual([1, 2, 4])
        expect(placesAtSpot(points, 3)).toEqual([3])
        // A place with no point drawn is only itself.
        expect(placesAtSpot(points, 9)).toEqual([9])
    })

    it('says whether zooming in would part a group, a few metres apart at street level being one spot', () => {
        const harbour = { lat: 50.7, lon: -1.5 }
        expect(oneSpotAt([{ key: 3, point: harbour }, { key: 7, point: harbour }], 14)).toEqual([3, 7])
        expect(oneSpotAt([{ key: 3, point: harbour }, { key: 7, point: { lat: 50.70009, lon: -1.5 } }], 14)).toEqual([3, 7])
        // A kilometre apart is hundreds of pixels at street level.
        expect(oneSpotAt([{ key: 3, point: harbour }, { key: 7, point: { lat: 50.709, lon: -1.5 } }], 14)).toBeNull()
        expect(oneSpotAt([{ key: 3, point: harbour }], 14)).toBeNull()
    })
})
