import { describe, expect, it } from 'vitest'

import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { createPlainMedia } from './plain-media'

function fakeUrls() {
    let n = 0
    const revoked: string[] = []
    return { revoked, createObjectURL: () => `blob:${++n}`, revokeObjectURL: (url: string) => void revoked.push(url) }
}

describe('pictures and recordings of a Plain Folder', () => {
    it('finds a file from the folder of the file that references it', async () => {
        let t = 0
        const tree = createMemoryTreeAdapter({ now: () => (t += 1000), seed: { 'guide/watering.md': 'x', 'guide/images/bed layout.png': 'png', 'clips/rain.mp4': 'mp4' } })
        const media = createPlainMedia(tree, fakeUrls())
        expect(await media.resolve('guide/watering.md', 'images/bed%20layout.png')).toEqual({ url: 'blob:1', name: 'bed layout.png', type: 'image/png' })
        expect(await media.resolve('guide/watering.md', '../clips/rain.mp4')).toMatchObject({ name: 'rain.mp4', type: 'video/mp4' })
        expect(await media.resolve('guide/watering.md', 'images/missing.png')).toBeNull()
    })

    it('resolves nothing outside the folder, and nothing for an address', async () => {
        const tree = createMemoryTreeAdapter({ now: () => 1, seed: { 'a.md': 'x' } })
        const media = createPlainMedia(tree, fakeUrls())
        expect(await media.resolve('a.md', '../secrets/key.png')).toBeNull()
        expect(await media.resolve('a.md', 'https://example.com/a.png')).toBeNull()
    })

    it('reads a file it holds again only when its stamps have changed', async () => {
        let t = 0
        const tree = createMemoryTreeAdapter({ now: () => (t += 1000), seed: { 'clips/rain.mp4': 'mp4' } })
        let reads = 0
        const counted = { stat: tree.stat, read: (path: string) => (reads++, tree.read(path)) }
        const media = createPlainMedia(counted, fakeUrls())
        const first = await media.resolvePath('clips/rain.mp4')
        // What an open tab asks on every pass over the folder.
        expect(await media.resolvePath('clips/rain.mp4')).toEqual(first)
        expect(await media.resolvePath('clips/rain.mp4')).toEqual(first)
        expect(reads).toBe(1)
        await tree.write('clips/rain.mp4', new TextEncoder().encode('longer'))
        expect((await media.resolvePath('clips/rain.mp4'))?.url).not.toBe(first?.url)
        expect(reads).toBe(2)
        await tree.remove('clips/rain.mp4')
        expect(await media.resolvePath('clips/rain.mp4')).toBeNull()
    })

    it('keeps one URL per file, renews it when the file changes, and releases them all', async () => {
        let t = 0
        const tree = createMemoryTreeAdapter({ now: () => (t += 1000), seed: { 'bed.png': 'one' } })
        const urls = fakeUrls()
        const media = createPlainMedia(tree, urls)
        const first = await media.resolvePath('bed.png')
        expect((await media.resolvePath('bed.png'))?.url).toBe(first?.url)
        await tree.write('bed.png', new TextEncoder().encode('two!'))
        const second = await media.resolvePath('bed.png')
        expect(second?.url).not.toBe(first?.url)
        expect(urls.revoked).toEqual([first?.url])
        media.dispose()
        expect(urls.revoked).toEqual([first?.url, second?.url])
    })
})
