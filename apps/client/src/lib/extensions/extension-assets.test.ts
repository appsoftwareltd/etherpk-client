import { describe, expect, it } from 'vitest'

import type { AssetStore } from '#lib/storage/fs/asset-store.js'
import { AssetRefusedError } from '#lib/storage/synced/server-asset-store.js'

import { createExtensionAssets, MAX_PREPARED_EDGE, preparedSize } from './extension-assets'

describe('the size an image is sent to a model at (ADR 0147)', () => {
    it('leaves an image whose long side fits as it is', () => {
        expect(preparedSize(1600, 900)).toEqual({ width: 1600, height: 900 })
        expect(preparedSize(MAX_PREPARED_EDGE, 10)).toEqual({ width: MAX_PREPARED_EDGE, height: 10 })
    })

    it('scales a larger one down to fit, keeping its shape', () => {
        expect(preparedSize(4000, 3000)).toEqual({ width: 2048, height: 1536 })
        expect(preparedSize(1000, 8192)).toEqual({ width: 250, height: 2048 })
    })

    it('never scales a side below one pixel', () => {
        expect(preparedSize(100_000, 1)).toEqual({ width: 2048, height: 1 })
    })
})

describe('an asset a document refers to, as an extension sees it', () => {
    const resolved: string[] = []
    const store = {
        resolve: async (ref: string) => {
            resolved.push(ref)
            return ref.includes('missing') ? null : { url: `blob:${ref}`, name: 'plan.png', type: 'image/png' }
        },
    } as unknown as AssetStore
    const assets = createExtensionAssets({ store: () => store, view: async () => {} })

    it('is named without the content hash or the id the graph added, with its whole name kept', () => {
        expect(assets.describe('../assets/plan.3f9a1c2e.png')).toEqual({ name: 'plan.png', fileName: 'plan.3f9a1c2e.png', image: true })
        expect(assets.describe('../assets/quote.0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.pdf')).toEqual({
            name: 'quote.pdf',
            fileName: 'quote.0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.pdf',
            image: false,
        })
        expect(assets.describe('../assets/garden%20notes.txt')).toEqual({ name: 'garden notes.txt', fileName: 'garden notes.txt', image: false })
    })

    it('is nothing for a reference that names no asset', () => {
        expect(assets.describe('https://example.com/plan.png')).toBeNull()
        expect(assets.describe('../assets/..%2Fpages%2FGarden.md')).toBeNull()
    })

    it('is shown at the address the store reads an image at, and only an image', async () => {
        expect(await assets.imageUrl('../assets/plan.3f9a1c2e.png')).toBe('blob:../assets/plan.3f9a1c2e.png')
        expect(await assets.imageUrl('../assets/missing.3f9a1c2e.png')).toBeNull()
        resolved.length = 0
        expect(await assets.imageUrl('../assets/quote.3f9a1c2e.pdf')).toBeNull()
        expect(resolved).toEqual([])
    })

    it('has no address where the graph keeps no assets, or the image cannot be read just now', async () => {
        expect(await createExtensionAssets({ store: () => null, view: async () => {} }).imageUrl('../assets/plan.3f9a1c2e.png')).toBeNull()
        const failing = { resolve: async () => Promise.reject(new Error('offline')) } as unknown as AssetStore
        expect(await createExtensionAssets({ store: () => failing, view: async () => {} }).imageUrl('../assets/plan.3f9a1c2e.png')).toBeNull()
    })
})

describe('an image an extension keeps as an asset', () => {
    const image = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/gif' })
    const saved = { ref: '../assets/plan.3f9a1c2e.gif', name: 'plan.3f9a1c2e.gif', stem: 'plan', isImage: true }
    const assetsOver = (save: AssetStore['save'] | null) => createExtensionAssets({ store: () => (save ? ({ save } as unknown as AssetStore) : null), view: async () => {} })

    it('answers its reference and its markdown', async () => {
        const stored = await assetsOver(async () => saved).storeImage(image, 'plan')
        expect(stored).toMatchObject({ stored: true, ref: saved.ref })
        expect(stored.stored && stored.markdown).toContain(saved.ref)
    })

    it('is named with the extension its type says, an SVG included, so the store reads it as an image', async () => {
        const names: string[] = []
        const keep = assetsOver(async (file) => {
            names.push(file.name)
            return saved
        })
        await keep.storeImage(new Blob(['<svg/>'], { type: 'image/svg+xml' }), 'drawing-image')
        await keep.storeImage(image, 'plan.png')
        expect(names).toEqual(['drawing-image.svg', 'plan.gif'])
    })

    it("says the store's own words when it refused, which name the limit", async () => {
        const refused = new AssetRefusedError('asset_size_limit')
        const stored = await assetsOver(async () => {
            throw refused
        }).storeImage(image, 'plan')
        expect(stored).toEqual({ stored: false, reason: refused.message })
    })

    it('says to try again when it failed some other way, keeping the error out of what the person reads', async () => {
        const stored = await assetsOver(async () => {
            throw new Error('socket hang up at 10.0.0.1')
        }).storeImage(image, 'plan')
        expect(stored).toEqual({ stored: false, reason: "It couldn't be stored just now. Try again." })
    })

    it('says so where the graph keeps no assets', async () => {
        expect((await assetsOver(null).storeImage(image, 'plan')).stored).toBe(false)
    })

    it('answers the old way through saveImage: markdown, or null however it failed', async () => {
        expect(await assetsOver(async () => saved).saveImage(image, 'plan')).toContain(saved.ref)
        expect(await assetsOver(null).saveImage(image, 'plan')).toBeNull()
    })
})

describe('images an extension shows in the Lightbox', () => {
    function viewing(store: AssetStore | null = { resolve: async (ref: string) => ({ url: `blob:${ref}`, name: 'plan.png', type: 'image/png' }) } as unknown as AssetStore) {
        const shown: { images: { name: string; load(): Promise<string | null> }[]; start: number }[] = []
        const assets = createExtensionAssets({
            store: () => store,
            view: async (images, start) => {
                shown.push({ images: [...images], start })
            },
        })
        return { assets, shown }
    }

    it('are the images among the references, named as describe names them, opened on the one asked for', async () => {
        const { assets, shown } = viewing()
        await assets.viewImages({
            refs: ['../assets/plan.3f9a1c2e.png', '../assets/quote.3f9a1c2e.pdf', '../assets/sketch.0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.png'],
            start: '../assets/sketch.0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d.png',
        })
        expect(shown).toHaveLength(1)
        expect(shown[0].images.map((image) => image.name)).toEqual(['plan.png', 'sketch.png'])
        expect(shown[0].start).toBe(1)
        expect(await shown[0].images[0].load()).toBe('blob:../assets/plan.3f9a1c2e.png')
    })

    it('open on the first image when the one asked for is not among them', async () => {
        const { assets, shown } = viewing()
        await assets.viewImages({ refs: ['../assets/plan.3f9a1c2e.png', '../assets/garden.3f9a1c2e.png'], start: '../assets/quote.3f9a1c2e.pdf' })
        expect(shown[0].start).toBe(0)
        await assets.viewImages({ refs: ['../assets/plan.3f9a1c2e.png'] })
        expect(shown[1].start).toBe(0)
    })

    it('open nothing when no reference names an image', async () => {
        const { assets, shown } = viewing()
        await assets.viewImages({ refs: ['../assets/quote.3f9a1c2e.pdf', 'https://example.com/plan.png'] })
        expect(shown).toEqual([])
    })

    it('show as images that could not be loaded where the graph keeps no assets', async () => {
        const { assets, shown } = viewing(null)
        await assets.viewImages({ refs: ['../assets/plan.3f9a1c2e.png'] })
        expect(await shown[0].images[0].load()).toBeNull()
    })
})
