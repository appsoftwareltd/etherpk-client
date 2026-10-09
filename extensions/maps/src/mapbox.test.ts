import { afterEach, describe, expect, it, vi } from 'vitest'

import { forgetMapboxForTests, forMapLibre, isRefused, loadMapboxStyle, MapboxRefusedError, mapboxRequestUrl, mapboxStyleAddress, onRefusal } from './mapbox'

// Mapbox as a basemap (ADR 0119, amended 2026-10-09): its `mapbox://` addresses on its API with the
// person's own token, its styles read once a page without what MapLibre refuses, and a token Mapbox
// refuses known to every map.

const EMPTY_STYLE = { version: 8, sources: {}, layers: [] }

describe("Mapbox's addresses", () => {
    it("puts a style, its sprite, its fonts and its tilesets on Mapbox's API with the token", () => {
        expect(mapboxRequestUrl(mapboxStyleAddress('streets'), 'pk.one')).toBe('https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=pk.one')
        expect(mapboxRequestUrl(mapboxStyleAddress('satellite'), 'pk.one')).toBe('https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12?access_token=pk.one')
        expect(mapboxRequestUrl('mapbox://sprites/mapbox/satellite-streets-v12@2x.json', 'pk.one')).toBe(
            'https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/sprite@2x.json?access_token=pk.one',
        )
        expect(mapboxRequestUrl('mapbox://sprites/mapbox/streets-v12.png', 'pk.one')).toBe('https://api.mapbox.com/styles/v1/mapbox/streets-v12/sprite.png?access_token=pk.one')
        expect(mapboxRequestUrl('mapbox://fonts/mapbox/DIN Pro Medium,Arial Unicode MS Regular/0-255.pbf', 'pk.one')).toBe(
            'https://api.mapbox.com/fonts/v1/mapbox/DIN Pro Medium,Arial Unicode MS Regular/0-255.pbf?access_token=pk.one',
        )
        expect(mapboxRequestUrl('mapbox://mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2', 'pk.one')).toBe(
            'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8,mapbox.mapbox-terrain-v2.json?secure&access_token=pk.one',
        )
    })

    it("gives Mapbox's own addresses the token when they lack it, and leaves every other address alone", () => {
        expect(mapboxRequestUrl('https://api.mapbox.com/v4/mapbox.satellite/3/4/2.webp', 'pk.one')).toBe('https://api.mapbox.com/v4/mapbox.satellite/3/4/2.webp?access_token=pk.one')
        expect(mapboxRequestUrl('https://a.tiles.mapbox.com/v4/x/1/2/3.vector.pbf?access_token=pk.theirs', 'pk.one')).toBe(
            'https://a.tiles.mapbox.com/v4/x/1/2/3.vector.pbf?access_token=pk.theirs',
        )
        expect(mapboxRequestUrl('https://maps.etherpk.com/styles/light.json', 'pk.one')).toBe('https://maps.etherpk.com/styles/light.json')
        expect(mapboxRequestUrl('https://api.mapbox.com.example.org/tiles/1/2/3.pbf', 'pk.one')).toBe('https://api.mapbox.com.example.org/tiles/1/2/3.pbf')
        expect(mapboxRequestUrl('http://api.mapbox.com/v4/x.json', 'pk.one')).toBe('http://api.mapbox.com/v4/x.json')
    })

    it('carries a token with characters an address cannot hold', () => {
        expect(mapboxRequestUrl(mapboxStyleAddress('streets'), 'pk.a&b=c')).toBe('https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=pk.a%26b%3Dc')
    })
})

describe("reading Mapbox's styles", () => {
    afterEach(() => forgetMapboxForTests())

    it('reads a style once a page for each style and token, without the globe MapLibre refuses', async () => {
        const fetcher = vi.fn(async () => Response.json({ ...EMPTY_STYLE, projection: { name: 'globe' } }))
        const first = await loadMapboxStyle('streets', 'pk.one', fetcher)
        await loadMapboxStyle('streets', 'pk.one', fetcher)
        expect(first).toEqual(EMPTY_STYLE)
        expect(fetcher).toHaveBeenCalledTimes(1)
        expect(fetcher).toHaveBeenCalledWith('https://api.mapbox.com/styles/v1/mapbox/streets-v12?access_token=pk.one')
        await loadMapboxStyle('satellite', 'pk.one', fetcher)
        await loadMapboxStyle('streets', 'pk.two', fetcher)
        expect(fetcher).toHaveBeenCalledTimes(3)
        expect(forMapLibre({ ...EMPTY_STYLE, name: 'Streets' } as never)).toEqual({ ...EMPTY_STYLE, name: 'Streets' })
    })

    it('knows a token Mapbox refuses from then on, and tells whoever listens', async () => {
        const heard = vi.fn()
        const stop = onRefusal(heard)
        for (const status of [401, 403]) {
            const token = `pk.refused-${status}`
            await expect(loadMapboxStyle('streets', token, async () => new Response('', { status }))).rejects.toBeInstanceOf(MapboxRefusedError)
            expect(isRefused(token)).toBe(true)
        }
        expect(heard).toHaveBeenCalledTimes(2)
        stop()
    })

    it('asks again after any other failure, which refuses nothing', async () => {
        const fetcher = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(Response.json(EMPTY_STYLE))
        await expect(loadMapboxStyle('streets', 'pk.good', fetcher)).rejects.toThrow('Mapbox answered 503 for its streets style.')
        await expect(loadMapboxStyle('streets', 'pk.good', fetcher)).resolves.toEqual(EMPTY_STYLE)
        expect(isRefused('pk.good')).toBe(false)
    })
})
