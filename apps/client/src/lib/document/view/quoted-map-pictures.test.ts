import { describe, expect, it, vi } from 'vitest'

import type { MapPicture } from '../publish/publish'
import type { MapPictureRenderer, MapPictureRequest } from '../publish/map-picture-renderer'
import { createContributionRegistry } from '$lib/surface/contribution-registry'
import { MAP_PICTURE_KIND } from '../publish/map-picture-renderer'

import { createQuotedMapPictures, quotedMapPicturesIn, quotedMapSize } from './quoted-map-pictures'

// The pictures of Map Blocks the Backlinks panel shows (ADR 0118, amended 2026-10-10): sized to
// the panel, drawn one at a time, kept for a while, and drawn without the basemap while it cannot
// be loaded.

const GARDEN = 'Garden @ 50.70000, -2.90000'
const KITCHEN = 'Kitchen @ 51.50000, -0.10000'
const SIZE = { width: 304, height: 171 }

function picture(request: MapPictureRequest | undefined): MapPicture {
    return { bytes: new Uint8Array([request?.basemap ? 1 : 0]), type: 'image/png', width: request?.width ?? 800, height: request?.height ?? 450 }
}

/** A renderer whose drawings finish only when the test says so, in the order they were asked for. */
function heldRenderer() {
    const calls: { source: string; request: MapPictureRequest | undefined; finish(): void; fail(): void }[] = []
    const renderer: MapPictureRenderer = (source, request) =>
        new Promise<MapPicture>((resolve, reject) => {
            calls.push({ source, request, finish: () => resolve(picture(request)), fail: () => reject(new Error("the map's style couldn't be loaded")) })
        })
    return { renderer, calls }
}

/** Let every settled promise run its callbacks. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('the size of a picture in the Backlinks panel', () => {
    it("is the card's width at 16:9, the width rounded up to 16 pixels so a small resize draws nothing new", () => {
        expect(quotedMapSize(300)).toEqual({ width: 304, height: 171 })
        expect(quotedMapSize(290)).toEqual({ width: 304, height: 171 })
    })

    it('is never lower than 160 pixels nor taller than 320', () => {
        expect(quotedMapSize(200)).toEqual({ width: 208, height: 160 })
        expect(quotedMapSize(900)).toEqual({ width: 912, height: 320 })
    })

    it('is nothing until the card has a width a map can be read at: a collapsed sidebar draws no maps', () => {
        expect(quotedMapSize(0)).toBeNull()
        expect(quotedMapSize(40)).toBeNull()
        expect(quotedMapSize(120)).toEqual({ width: 128, height: 160 })
    })
})

describe('the pictures of Map Blocks in the Backlinks panel', () => {
    it("are drawn at the panel's size and in its theme, over the basemap", async () => {
        const renderer = vi.fn<MapPictureRenderer>(async (_source, request) => picture(request))
        const pictures = createQuotedMapPictures(renderer)
        const drawn = await pictures.draw(GARDEN, SIZE, true)
        expect(renderer).toHaveBeenCalledWith(GARDEN, { ...SIZE, dark: true, basemap: true })
        expect(drawn.basemap).toBe(true)
        expect(drawn.picture.width).toBe(304)
    })

    it('are kept, so a map drawn once is not drawn again at the same size and theme', async () => {
        const renderer = vi.fn<MapPictureRenderer>(async (_source, request) => picture(request))
        const pictures = createQuotedMapPictures(renderer)
        const first = await pictures.draw(GARDEN, SIZE, false)
        expect(pictures.kept(GARDEN, SIZE, false)).toBe(first)
        expect(await pictures.draw(GARDEN, SIZE, false)).toBe(first)
        expect(renderer).toHaveBeenCalledTimes(1)
        // Another theme or size is another picture.
        expect(pictures.kept(GARDEN, SIZE, true)).toBeUndefined()
        expect(pictures.kept(GARDEN, { width: 320, height: 180 }, false)).toBeUndefined()
    })

    it('are kept up to a limit, the one shown longest ago let go first', async () => {
        const renderer = vi.fn<MapPictureRenderer>(async (_source, request) => picture(request))
        const pictures = createQuotedMapPictures(renderer, { capacity: 2 })
        await pictures.draw(GARDEN, SIZE, false)
        await pictures.draw(KITCHEN, SIZE, false)
        // Garden is shown again, so Kitchen is now the one shown longest ago.
        expect(await pictures.draw(GARDEN, SIZE, false)).toBeDefined()
        await pictures.draw('Shed @ 52.00000, -1.00000', SIZE, false)
        expect(pictures.kept(GARDEN, SIZE, false)).toBeDefined()
        expect(pictures.kept(KITCHEN, SIZE, false)).toBeUndefined()
    })

    it('are drawn one at a time, so they never hold more than one more WebGL context', async () => {
        const { renderer, calls } = heldRenderer()
        const pictures = createQuotedMapPictures(renderer)
        const garden = pictures.draw(GARDEN, SIZE, false)
        const kitchen = pictures.draw(KITCHEN, SIZE, false)
        await settle()
        expect(calls.map((call) => call.source)).toEqual([GARDEN])
        calls[0].finish()
        await garden
        await settle()
        expect(calls.map((call) => call.source)).toEqual([GARDEN, KITCHEN])
        calls[1].finish()
        expect((await kitchen).basemap).toBe(true)
    })

    it('share one drawing between two references quoting the same map', async () => {
        const { renderer, calls } = heldRenderer()
        const pictures = createQuotedMapPictures(renderer)
        const one = pictures.draw(GARDEN, SIZE, false)
        const two = pictures.draw(GARDEN, SIZE, false)
        await settle()
        calls[0].finish()
        expect(await one).toBe(await two)
        expect(calls).toHaveLength(1)
    })

    it('are not drawn once nobody waits for them: a map scrolled past before its turn', async () => {
        const { renderer, calls } = heldRenderer()
        const pictures = createQuotedMapPictures(renderer)
        const garden = pictures.draw(GARDEN, SIZE, false)
        const passed = new AbortController()
        const kitchen = pictures.draw(KITCHEN, SIZE, false, passed.signal)
        passed.abort()
        await expect(kitchen).rejects.toMatchObject({ name: 'AbortError' })
        calls[0].finish()
        await garden
        await settle()
        expect(calls.map((call) => call.source)).toEqual([GARDEN])
    })

    it('are still drawn for a second reference when the first stops waiting', async () => {
        const { renderer, calls } = heldRenderer()
        const pictures = createQuotedMapPictures(renderer)
        const passed = new AbortController()
        const first = pictures.draw(GARDEN, SIZE, false, passed.signal)
        const second = pictures.draw(GARDEN, SIZE, false)
        passed.abort()
        await expect(first).rejects.toMatchObject({ name: 'AbortError' })
        await settle()
        calls[0].finish()
        expect((await second).basemap).toBe(true)
    })

    it('are drawn without the basemap when it cannot be loaded, and say so', async () => {
        const { renderer, calls } = heldRenderer()
        const pictures = createQuotedMapPictures(renderer)
        const garden = pictures.draw(GARDEN, SIZE, false)
        await settle()
        calls[0].fail()
        await settle()
        expect(calls[1].request).toEqual({ ...SIZE, dark: false, basemap: false })
        calls[1].finish()
        expect((await garden).basemap).toBe(false)
    })

    it('skip the basemap for a while once it failed, so each map does not wait out the same failure', async () => {
        let now = 1_000
        const { renderer, calls } = heldRenderer()
        const pictures = createQuotedMapPictures(renderer, { now: () => now })
        const garden = pictures.draw(GARDEN, SIZE, false)
        await settle()
        calls[0].fail()
        await settle()
        calls[1].finish()
        await garden
        const kitchen = pictures.draw(KITCHEN, SIZE, false)
        await settle()
        expect(calls[2].request?.basemap).toBe(false)
        calls[2].finish()
        await kitchen
        // A minute on, the basemap is tried again, and a picture drawn without it is not kept.
        now += 60_000
        expect(pictures.kept(GARDEN, SIZE, false)).toBeUndefined()
        const again = pictures.draw(GARDEN, SIZE, false)
        await settle()
        expect(calls[3].request?.basemap).toBe(true)
        calls[3].finish()
        expect((await again).basemap).toBe(true)
    })

    it('try the basemap again as soon as the browser is back online', async () => {
        const { renderer, calls } = heldRenderer()
        const pictures = createQuotedMapPictures(renderer)
        const garden = pictures.draw(GARDEN, SIZE, false)
        await settle()
        calls[0].fail()
        await settle()
        calls[1].finish()
        await garden
        pictures.basemapBack()
        expect(pictures.kept(GARDEN, SIZE, false)).toBeUndefined()
        const again = pictures.draw(GARDEN, SIZE, false)
        await settle()
        expect(calls[2].request?.basemap).toBe(true)
        calls[2].finish()
        await again
    })

    it('fail when the map cannot be drawn at all, and the next map is still drawn', async () => {
        const renderer = vi.fn<MapPictureRenderer>(async () => {
            throw new Error("this browser can't draw maps")
        })
        const pictures = createQuotedMapPictures(renderer)
        await expect(pictures.draw(GARDEN, SIZE, false)).rejects.toThrow("can't draw maps")
        await expect(pictures.draw(KITCHEN, SIZE, false)).rejects.toThrow("can't draw maps")
        expect(pictures.kept(GARDEN, SIZE, false)).toBeUndefined()
    })
})

describe("a graph's pictures", () => {
    it('are drawn by the renderer its maps extension contributed, and are none without one', () => {
        const registry = createContributionRegistry()
        expect(quotedMapPicturesIn(registry, 'map')).toBeNull()
        registry.register(MAP_PICTURE_KIND, 'map', async (_source: string, request?: MapPictureRequest) => picture(request))
        expect(quotedMapPicturesIn(registry, 'map')).not.toBeNull()
        expect(quotedMapPicturesIn(registry, 'mermaid')).toBeNull()
    })

    it("are the graph's own, kept while the graph is open", () => {
        const renderer: MapPictureRenderer = async (_source, request) => picture(request)
        const one = createContributionRegistry()
        const two = createContributionRegistry()
        one.register(MAP_PICTURE_KIND, 'map', renderer)
        two.register(MAP_PICTURE_KIND, 'map', renderer)
        expect(quotedMapPicturesIn(one, 'map')).toBe(quotedMapPicturesIn(one, 'map'))
        expect(quotedMapPicturesIn(one, 'map')).not.toBe(quotedMapPicturesIn(two, 'map'))
    })
})
