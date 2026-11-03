import type { ExtensionAssets } from '@appsoftwareltd/etherpk-extension-api'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { assetShown, setTaskEditorAssets, taskAssetImage, viewTaskImages } from './task-editor-assets'

// The Task Editor's Assets list (ADR 0170): each asset by the name a person reads, with a picture of
// an image, through the graph's assets as the extension's context reaches them.

const assets: ExtensionAssets = {
    prepareImage: async (image) => image,
    saveImage: async () => null,
    describe: (ref) => (ref.startsWith('../assets/') ? { name: 'plan.png', fileName: ref.slice('../assets/'.length), image: ref.endsWith('.png') } : null),
    imageUrl: async (ref) => (ref.endsWith('.png') ? `blob:${ref}` : null),
    viewImages: async () => {},
}

afterEach(() => setTaskEditorAssets(null))

describe('an asset in the Task Editor', () => {
    it('is named as the graph names it, with its whole file name kept for the tooltip', async () => {
        setTaskEditorAssets(assets)
        expect(assetShown('../assets/plan.3f9a1c2e.png')).toEqual({ ref: '../assets/plan.3f9a1c2e.png', name: 'plan.png', fileName: 'plan.3f9a1c2e.png', image: true })
        expect(await taskAssetImage('../assets/plan.3f9a1c2e.png')).toBe('blob:../assets/plan.3f9a1c2e.png')
    })

    it('is named by the last part of its reference, with no picture, before the extension has started in a graph', async () => {
        expect(assetShown('../assets/garden%20plan.3f9a1c2e.pdf')).toEqual({
            ref: '../assets/garden%20plan.3f9a1c2e.pdf',
            name: 'garden plan.3f9a1c2e.pdf',
            fileName: 'garden plan.3f9a1c2e.pdf',
            image: false,
        })
        expect(await taskAssetImage('../assets/plan.3f9a1c2e.png')).toBeNull()
    })
})

describe("a task's images in the Client's Lightbox", () => {
    it('are the task\'s assets in list order, opened on the thumbnail chosen; the Client leaves out what is not an image', async () => {
        const viewImages = vi.fn(async () => {})
        setTaskEditorAssets({ ...assets, viewImages })
        const refs = ['../assets/plan.3f9a1c2e.png', '../assets/quote.3f9a1c2e.pdf', '../assets/sketch.3f9a1c2e.png']
        await viewTaskImages(refs, '../assets/sketch.3f9a1c2e.png')
        expect(viewImages).toHaveBeenCalledWith({ refs, start: '../assets/sketch.3f9a1c2e.png' })
    })

    it('open nothing before the extension has started in a graph', async () => {
        await expect(viewTaskImages(['../assets/plan.3f9a1c2e.png'], '../assets/plan.3f9a1c2e.png')).resolves.toBeUndefined()
    })
})
