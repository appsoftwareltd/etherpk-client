import { afterEach, describe, expect, it, vi } from 'vitest'

import { createBasemaps } from './basemap'
import type { MapStyles } from './map-host'
import { forgetMapboxForTests, loadMapboxStyle } from './mapbox'

// Which basemap a graph's maps are drawn over (ADR 0119, amended 2026-10-09): the deployment's, or
// the person's own Mapbox, street map or satellite, until Mapbox refuses the token.

const STYLES: MapStyles = { light: 'https://maps.example.com/light.json', dark: 'https://maps.example.com/dark.json' }

function setUp(styles: MapStyles | null = STYLES) {
    const values = new Map<string, string>()
    const listeners = new Set<() => void>()
    const settings = {
        get: (id: string) => values.get(id),
        subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => void listeners.delete(listener)
        },
    }
    const stored = new Map<string, unknown>()
    const storage = { get: <T>(key: string) => stored.get(key) as T | undefined, set: (key: string, value: unknown) => void stored.set(key, value) }
    /** The person sets their token, or removes it, in the maps' settings. */
    const setToken = (token?: string) => {
        if (token === undefined) values.delete('mapbox-token')
        else values.set('mapbox-token', token)
        for (const listener of listeners) listener()
    }
    return { basemaps: createBasemaps(styles, settings, storage), setToken, stored, listeners, storage, settings }
}

describe('the basemap maps are drawn over', () => {
    afterEach(() => forgetMapboxForTests())

    it("is the deployment's for each theme, the same object each time, and none where it has none", () => {
        const { basemaps } = setUp()
        expect(basemaps.current(false)).toEqual({ kind: 'style', url: STYLES.light })
        expect(basemaps.current(true)).toEqual({ kind: 'style', url: STYLES.dark })
        expect(basemaps.current(false)).toBe(basemaps.current(false))
        expect(basemaps.mapbox()).toBe(false)
        expect(setUp(null).basemaps.current(false)).toBeNull()
    })

    it("is the person's own Mapbox street map in both themes, and its satellite imagery once switched, which this device remembers", () => {
        const { basemaps, setToken, stored, storage, settings } = setUp(null)
        setToken(' pk.one ')
        expect(basemaps.current(false)).toEqual({ kind: 'mapbox', style: 'streets', token: 'pk.one' })
        expect(basemaps.current(true)).toBe(basemaps.current(false))
        expect(basemaps.mapbox()).toBe(true)

        const heard = vi.fn()
        basemaps.subscribe(heard)
        basemaps.setSatellite(true)
        basemaps.setSatellite(true)
        expect(heard).toHaveBeenCalledTimes(1)
        expect(basemaps.current(false)).toEqual({ kind: 'mapbox', style: 'satellite', token: 'pk.one' })
        expect(stored.get('satellite')).toBe(true)
        expect(createBasemaps(null, settings, storage).satellite()).toBe(true)

        setToken()
        expect(basemaps.current(false)).toBeNull()
        expect(basemaps.mapbox()).toBe(false)
        expect(heard).toHaveBeenCalledTimes(2)
    })

    it("goes back to the deployment's when Mapbox refuses the token, until the token changes", async () => {
        const { basemaps, setToken } = setUp()
        setToken('pk.refused')
        const heard = vi.fn()
        basemaps.subscribe(heard)
        await expect(loadMapboxStyle('streets', 'pk.refused', async () => new Response('', { status: 401 }))).rejects.toThrow()
        expect(heard).toHaveBeenCalledTimes(1)
        expect(basemaps.refused()).toBe(true)
        expect(basemaps.mapbox()).toBe(false)
        expect(basemaps.current(false)).toEqual({ kind: 'style', url: STYLES.light })

        setToken('pk.corrected')
        expect(basemaps.refused()).toBe(false)
        expect(basemaps.current(false)).toEqual({ kind: 'mapbox', style: 'streets', token: 'pk.corrected' })
    })

    it('hears the settings only while someone listens to it', () => {
        const { basemaps, listeners } = setUp()
        const stopFirst = basemaps.subscribe(() => {})
        const stopSecond = basemaps.subscribe(() => {})
        expect(listeners.size).toBe(1)
        stopFirst()
        expect(listeners.size).toBe(1)
        stopSecond()
        expect(listeners.size).toBe(0)
    })
})
