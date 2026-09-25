import { describe, expect, it } from 'vitest'

import { type Subdir, SUBDIRS } from './directory-adapter'
import { createMemoryDirectoryAdapter } from './memory-adapter'

/** A clock that advances 1000ms each tick, so mtimes are deterministic and distinct. */
function tickingClock(start = 1000): () => number {
    let t = start
    return () => (t += 1000)
}

describe('createMemoryDirectoryAdapter', () => {
    it('ensureSkeleton leaves every subdir present but empty', async () => {
        const fs = createMemoryDirectoryAdapter({ now: tickingClock() })
        await fs.ensureSkeleton()
        for (const subdir of SUBDIRS) {
            expect(await fs.list(subdir)).toEqual([])
        }
    })

    it('write returns a clock-stamped mtime and read round-trips it', async () => {
        const fs = createMemoryDirectoryAdapter({ now: tickingClock() }) // first now() => 2000
        const written = await fs.write('pages', 'Physics.md', '# Physics')
        expect(written.lastModified).toBe(2000)

        const read = await fs.read('pages', 'Physics.md')
        expect(read).toEqual({ text: '# Physics', lastModified: 2000, size: 9 })
    })

    it('a second write overwrites the content and bumps the mtime', async () => {
        const fs = createMemoryDirectoryAdapter({ now: tickingClock() })
        await fs.write('pages', 'Physics.md', 'one') // 2000
        const second = await fs.write('pages', 'Physics.md', 'two') // 3000
        expect(second.lastModified).toBe(3000)
        expect(await fs.read('pages', 'Physics.md')).toEqual({ text: 'two', lastModified: 3000, size: 3 })
    })

    it('reports each file’s size in bytes on list, read and write, as a real listing does', async () => {
        // The store's reconcile fast path keys on (mtime, size): an edit that keeps the mtime
        // (inside the timestamp's resolution, or `rsync -t`) is still caught when the length moved.
        const fs = createMemoryDirectoryAdapter({ now: tickingClock() })
        const written = await fs.write('pages', 'A.md', 'héllo') // five characters, six bytes of UTF-8
        expect(written.size).toBe(6)
        expect((await fs.read('pages', 'A.md')).size).toBe(6)
        expect(await fs.list('pages')).toEqual([{ name: 'A.md', lastModified: 2000, size: 6 }])

        await fs.writeBinary('assets', 'x.png', new Uint8Array([1, 2, 3]))
        expect((await fs.list('assets'))[0].size).toBe(3)
    })

    it('list reflects writes and removes; remove then read rejects', async () => {
        const fs = createMemoryDirectoryAdapter({ now: tickingClock() })
        await fs.write('journals', '2026-06-02.md', 'today')
        await fs.write('journals', '2026-06-01.md', 'yesterday')
        expect((await fs.list('journals')).map((e) => e.name).sort()).toEqual([
            '2026-06-01.md',
            '2026-06-02.md',
        ])

        await fs.remove('journals', '2026-06-01.md')
        expect((await fs.list('journals')).map((e) => e.name)).toEqual(['2026-06-02.md'])
        await expect(fs.read('journals', '2026-06-01.md')).rejects.toThrow()
    })

    it('reading an absent file rejects', async () => {
        const fs = createMemoryDirectoryAdapter({ now: tickingClock() })
        await expect(fs.read('pages', 'Nope.md')).rejects.toThrow()
    })

    it('remove of an absent file resolves quietly', async () => {
        const fs = createMemoryDirectoryAdapter({ now: tickingClock() })
        await expect(fs.remove('pages', 'Nope.md')).resolves.toBeUndefined()
    })

    it('list does not bleed across subdirs', async () => {
        const fs = createMemoryDirectoryAdapter({ now: tickingClock() })
        await fs.write('pages', 'A.md', 'a')
        await fs.write('journals', 'B.md', 'b')
        expect((await fs.list('pages') as { name: string }[]).map((e) => e.name)).toEqual(['A.md'])
        expect((await fs.list('journals')).map((e) => e.name)).toEqual(['B.md'])
    })

    it('returns copies, never shared references', async () => {
        const fs = createMemoryDirectoryAdapter({ now: tickingClock() })
        await fs.write('pages', 'A.md', 'a')
        const first = await fs.read('pages', 'A.md')
        first.text = 'mutated'
        const second = await fs.read('pages', 'A.md')
        expect(second.text).toBe('a')
    })

    it('seeds initial files with the clock applied', async () => {
        const seed: Partial<Record<Subdir, Record<string, string>>> = {
            pages: { 'Seeded.md': 'hi' },
        }
        const fs = createMemoryDirectoryAdapter({ now: tickingClock(), seed })
        const read = await fs.read('pages', 'Seeded.md')
        expect(read.text).toBe('hi')
        expect(typeof read.lastModified).toBe('number')
    })

    it('writeBinary / readBinary round-trip raw bytes (a copy, not a shared reference)', async () => {
        const fs = createMemoryDirectoryAdapter({ now: tickingClock() })
        const written = await fs.writeBinary('assets', 'x.png', new Uint8Array([1, 2, 3]))
        expect(written.lastModified).toBe(2000)

        const read = await fs.readBinary('assets', 'x.png')
        expect([...read.bytes]).toEqual([1, 2, 3])
        read.bytes[0] = 99
        expect([...(await fs.readBinary('assets', 'x.png')).bytes]).toEqual([1, 2, 3])
    })

    it('exists reports presence and remove clears it', async () => {
        const fs = createMemoryDirectoryAdapter({ now: tickingClock() })
        expect(await fs.exists('assets', 'x.png')).toBe(false)
        await fs.writeBinary('assets', 'x.png', new Uint8Array([7]))
        expect(await fs.exists('assets', 'x.png')).toBe(true)
        await fs.remove('assets', 'x.png')
        expect(await fs.exists('assets', 'x.png')).toBe(false)
    })
})
