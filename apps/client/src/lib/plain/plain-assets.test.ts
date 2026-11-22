import { describe, expect, it } from 'vitest'

import { createMemoryTreeAdapter } from './memory-tree-adapter'
import { assetDirectoryFor, createPlainAssetStore, safeFileName, saveBeside } from './plain-assets'
import { createPlainMedia } from './plain-media'

const bytes = (text: string) => new TextEncoder().encode(text)
const tree = () => createMemoryTreeAdapter({ now: () => 1, seed: { 'guide/watering.md': '# Watering' } })
const names = async (t: ReturnType<typeof tree>, dir: string) => (await t.list(dir)).map((entry) => entry.name).sort()

describe('where a pasted file goes', () => {
    it('is an assets directory beside the document, the document’s own, or one named after it', () => {
        expect(assetDirectoryFor('guide/watering.md', 'assets')).toBe('guide/assets')
        expect(assetDirectoryFor('guide/watering.md', 'beside')).toBe('guide')
        expect(assetDirectoryFor('guide/watering.md', 'named')).toBe('guide/watering.assets')
        expect(assetDirectoryFor('README.md', 'assets')).toBe('assets')
        expect(assetDirectoryFor('README.md', 'beside')).toBe('')
    })

    it('keeps a file’s own name, with what no file system takes replaced', () => {
        expect(safeFileName('bed layout (north).png')).toBe('bed layout (north).png')
        expect(safeFileName('what: is/this?.png')).toBe('what- is-this-.png')
        expect(safeFileName('  .. ')).toBe('file')
    })
})

describe('saving a pasted file near its document', () => {
    it('creates the directory the first time, and keeps the name', async () => {
        const t = tree()
        expect(await saveBeside(t, 'guide/watering.md', { name: 'bed layout.png', bytes: bytes('png') }, 'assets')).toEqual({ path: 'guide/assets/bed layout.png', reused: false })
        expect(await names(t, 'guide')).toEqual(['assets', 'watering.md'])
    })

    it('uses the same file again for the same bytes, and numbers a different file of the same name', async () => {
        const t = tree()
        await saveBeside(t, 'guide/watering.md', { name: 'bed.png', bytes: bytes('one') }, 'assets')
        expect(await saveBeside(t, 'guide/watering.md', { name: 'bed.png', bytes: bytes('one') }, 'assets')).toEqual({ path: 'guide/assets/bed.png', reused: true })
        expect(await saveBeside(t, 'guide/watering.md', { name: 'bed.png', bytes: bytes('two') }, 'assets')).toEqual({ path: 'guide/assets/bed (2).png', reused: false })
        expect(await saveBeside(t, 'guide/watering.md', { name: 'bed.png', bytes: bytes('two') }, 'assets')).toEqual({ path: 'guide/assets/bed (2).png', reused: true })
        expect(await names(t, 'guide/assets')).toEqual(['bed (2).png', 'bed.png'])
    })

    it('gives the editor a relative, escaped link, and finds the file again from it', async () => {
        const t = tree()
        let n = 0
        const media = createPlainMedia(t, { createObjectURL: () => `blob:${++n}`, revokeObjectURL: () => {} })
        const store = createPlainAssetStore(t, media, () => 'guide/watering.md', () => 'assets')
        const saved = await store.save({ name: 'bed layout.png', bytes: bytes('png'), type: 'image/png' })
        expect(saved).toEqual({ ref: 'assets/bed%20layout.png', name: 'bed layout.png', stem: 'bed layout', isImage: true })
        expect(await store.resolve(saved.ref)).toEqual({ url: 'blob:1', name: 'bed layout.png', type: 'image/png' })
        expect(await store.readBytes(saved.ref)).toMatchObject({ name: 'bed layout.png', type: 'image/png' })

        const pdf = await store.save({ name: 'pump.pdf', bytes: bytes('pdf'), type: 'application/pdf' })
        expect(pdf).toMatchObject({ ref: 'assets/pump.pdf', isImage: false })
        expect(await store.resolve('../../outside.png')).toBeNull()
    })
})
