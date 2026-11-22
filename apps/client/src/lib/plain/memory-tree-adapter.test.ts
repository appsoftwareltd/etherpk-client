import { describe, expect, it } from 'vitest'

import { isNotFound } from './folder-tree-adapter'
import { createMemoryTreeAdapter } from './memory-tree-adapter'

function clock(start = 1000) {
    let t = start
    return () => (t += 1000)
}
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
const utf8 = (value: string) => new TextEncoder().encode(value)
const names = (entries: Array<{ name: string }>) => entries.map((entry) => entry.name).sort()

describe('the in-memory folder tree', () => {
    const seeded = () =>
        createMemoryTreeAdapter({
            now: clock(),
            seed: { 'README.md': '# Garden', 'guide/watering.md': 'water', 'guide/images/bed.png': new Uint8Array([1, 2, 3]) },
        })

    it('lists one directory at a time, files and directories alike', async () => {
        const tree = seeded()
        expect(await tree.list('')).toEqual(expect.arrayContaining([{ name: 'README.md', kind: 'file' }, { name: 'guide', kind: 'directory' }]))
        expect(names(await tree.list('guide'))).toEqual(['images', 'watering.md'])
        await expect(tree.list('nowhere')).rejects.toSatisfy(isNotFound)
    })

    it('reads bytes with their stamps, and says when nothing is there', async () => {
        const tree = seeded()
        const file = await tree.read('guide/watering.md')
        expect(text(file.bytes)).toBe('water')
        expect(file.size).toBe(5)
        expect(await tree.stat('guide/watering.md')).toEqual({ kind: 'file', lastModified: file.lastModified, size: 5 })
        expect(await tree.stat('guide')).toEqual({ kind: 'directory' })
        expect(await tree.stat('guide/soil.md')).toBeNull()
        await expect(tree.read('guide/soil.md')).rejects.toSatisfy(isNotFound)
    })

    it('writes into a directory that exists, and refuses one that does not', async () => {
        const tree = seeded()
        const stamp = await tree.write('guide/soil.md', utf8('clay'))
        expect(stamp.size).toBe(4)
        expect(text((await tree.read('guide/soil.md')).bytes)).toBe('clay')
        await expect(tree.write('manuals/pump.md', utf8('x'))).rejects.toSatisfy(isNotFound)
        await tree.createDirectory('manuals/old')
        await tree.write('manuals/old/pump.md', utf8('x'))
        expect(names(await tree.list('manuals'))).toEqual(['old'])
    })

    it('removes a file, or a directory with everything in it', async () => {
        const tree = seeded()
        await tree.remove('guide')
        expect(names(await tree.list(''))).toEqual(['README.md'])
        expect(await tree.stat('guide/images/bed.png')).toBeNull()
        await tree.remove('guide') // already gone
    })

    it('moves a file or a directory, and refuses a name that is taken', async () => {
        const tree = seeded()
        await tree.move('guide/watering.md', 'watering.md')
        expect(names(await tree.list(''))).toEqual(['README.md', 'guide', 'watering.md'])
        await tree.move('guide', 'handbook')
        expect(text((await tree.read('handbook/images/bed.png')).bytes)).toBe('\u0001\u0002\u0003')
        await expect(tree.move('watering.md', 'README.md')).rejects.toThrow(/already/)
    })

    it('on a folder that ignores case, reaches a file by any casing and answers its own spelling', async () => {
        const tree = createMemoryTreeAdapter({ now: clock(), seed: { 'Guide/README.md': 'r' }, ignoreCase: true })
        expect(text((await tree.read('guide/readme.md')).bytes)).toBe('r')
        expect(await tree.canonicalPath('guide/readme.md')).toBe('Guide/README.md')
        await tree.write('GUIDE/readme.MD', utf8('again'))
        expect(names(await tree.list('Guide'))).toEqual(['README.md'])
        await tree.move('Guide/README.md', 'Guide/Readme.md') // a change of case is a rename
        expect(names(await tree.list('guide'))).toEqual(['Readme.md'])
    })

    it('where case matters, two casings are two files', async () => {
        const tree = seeded()
        expect(await tree.canonicalPath('readme.md')).toBeNull()
        await tree.write('readme.md', utf8('other'))
        expect(names(await tree.list(''))).toEqual(['README.md', 'guide', 'readme.md'])
    })
})
