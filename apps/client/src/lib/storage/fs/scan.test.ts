import { describe, expect, it } from 'vitest'

import type { DirectoryAdapter } from './directory-adapter'
import { createMemoryDirectoryAdapter } from './memory-adapter'
import { scanGraph } from './scan'

function clock(start = 1000) {
    let t = start
    return () => (t += 1000)
}

describe('scanGraph', () => {
    it('builds entries for journals and pages with the right kind, concept, and key', async () => {
        const fs = createMemoryDirectoryAdapter({
            now: clock(),
            seed: {
                journals: { '2026-06-02.md': '# Today' },
                pages: { 'Quantum Mechanics.md': '---\ntitle: Quantum Mechanics\n---\nbody' },
            },
        })

        const entries = await scanGraph(fs)
        const byKey = Object.fromEntries(entries.map((e) => [e.key, e]))

        expect(byKey['2026-06-02']).toMatchObject({
            kind: 'journal',
            concept: '2026-06-02',
            key: '2026-06-02',
            subdir: 'journals',
            fileName: '2026-06-02.md',
        })
        expect(byKey['quantum mechanics']).toMatchObject({
            kind: 'page',
            concept: 'Quantum Mechanics',
            key: 'quantum mechanics',
            subdir: 'pages',
            fileName: 'Quantum Mechanics.md',
        })
    })

    it('carries the listing’s mtime and byte size, the pair the reconcile fast path keys on', async () => {
        const text = '---\ntitle: Quantum Mechanics\n---\nbødy'
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed: { pages: { 'Quantum Mechanics.md': text } } })

        const [entry] = await scanGraph(fs)

        expect(entry.lastModified).toBe(2000)
        expect(entry.size).toBe(new TextEncoder().encode(text).length)
    })

    it('takes the frontmatter title over the filename for the concept', async () => {
        const fs = createMemoryDirectoryAdapter({
            now: clock(),
            seed: { pages: { 'mangled_name.md': '---\ntitle: Proper Name\n---\n' } },
        })
        const [entry] = await scanGraph(fs)
        expect(entry.concept).toBe('Proper Name')
        expect(entry.key).toBe('proper name')
        expect(entry.fileName).toBe('mangled_name.md')
    })

    it('captures aliases', async () => {
        const fs = createMemoryDirectoryAdapter({
            now: clock(),
            seed: { pages: { 'A.md': '---\ntitle: A\naliases:\n  - Alpha\n  - Ay\n---\n' } },
        })
        const [entry] = await scanGraph(fs)
        expect(entry.aliases).toEqual(['Alpha', 'Ay'])
    })

    it('ignores non-markdown files', async () => {
        const fs = createMemoryDirectoryAdapter({
            now: clock(),
            seed: { pages: { 'A.md': 'a', 'notes.txt': 'x', '.DS_Store': '' } },
        })
        const entries = await scanGraph(fs)
        expect(entries.map((e) => e.fileName)).toEqual(['A.md'])
    })

    it('sorts journals by date descending, then pages case-insensitively ascending', async () => {
        const fs = createMemoryDirectoryAdapter({
            now: clock(),
            seed: {
                journals: { '2026-06-01.md': '', '2026-06-03.md': '', '2026-06-02.md': '' },
                pages: { 'banana.md': '', 'Apple.md': '', 'cherry.md': '' },
            },
        })
        const entries = await scanGraph(fs)
        expect(entries.map((e) => e.concept)).toEqual([
            '2026-06-03',
            '2026-06-02',
            '2026-06-01',
            'Apple',
            'banana',
            'cherry',
        ])
    })
})

/** Record which files a scan opens, so a test can say what was read and what was reused. */
function countingReads(fs: DirectoryAdapter): { adapter: DirectoryAdapter; reads: string[] } {
    const reads: string[] = []
    const adapter: DirectoryAdapter = {
        ...fs,
        read: async (subdir, name) => {
            reads.push(`${subdir}/${name}`)
            return fs.read(subdir, name)
        },
    }
    return { adapter, reads }
}

describe('scanGraph over the previous scan', () => {
    const seed = {
        journals: { '2026-09-22.md': '- today' },
        pages: { 'A.md': '---\ntitle: A\n---\na', 'B.md': '---\ntitle: B\n---\nb' },
    }

    it('reads only the files whose listing stamps moved, and reuses the other entries as they are', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed })
        const { adapter, reads } = countingReads(fs)
        const first = await scanGraph(adapter)
        expect(reads).toHaveLength(3)

        reads.length = 0
        await fs.write('pages', 'B.md', '---\ntitle: B\n---\nb, longer')
        const second = await scanGraph(adapter, { previous: first })

        expect(reads).toEqual(['pages/B.md'])
        // The same object, so stamps the store records on an entry after its own write carry over.
        expect(second.find((e) => e.key === 'a')).toBe(first.find((e) => e.key === 'a'))
        expect(second.find((e) => e.key === '2026-09-22')).toBe(first.find((e) => e.key === '2026-09-22'))
        expect(second.find((e) => e.key === 'b')?.size).toBe(new TextEncoder().encode('---\ntitle: B\n---\nb, longer').length)
    })

    it('re-derives the identity of a file that moved: a title edited outside the app re-keys its entry', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed })
        const first = await scanGraph(fs)

        await fs.write('pages', 'B.md', '---\ntitle: Bee\n---\nb')
        const second = await scanGraph(fs, { previous: first })

        expect(second.map((e) => e.key)).toEqual(['2026-09-22', 'a', 'bee'])
        expect(second.find((e) => e.key === 'bee')).toMatchObject({ concept: 'Bee', fileName: 'B.md' })
    })

    it('reads a file the previous scan never saw and drops one that is gone', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed })
        const { adapter, reads } = countingReads(fs)
        const first = await scanGraph(adapter)

        reads.length = 0
        await fs.write('pages', 'C.md', '---\ntitle: C\n---\nc')
        await fs.remove('pages', 'A.md')
        const second = await scanGraph(adapter, { previous: first })

        expect(reads).toEqual(['pages/C.md'])
        expect(second.map((e) => e.key)).toEqual(['2026-09-22', 'b', 'c'])
    })

    it('leaves a file whose own write is in flight alone: its previous entry stands, unread, whatever the stamps say', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed })
        const { adapter, reads } = countingReads(fs)
        const first = await scanGraph(adapter)
        const before = first.find((e) => e.key === 'b')!

        reads.length = 0
        // The bytes have landed (a listing reports the new stamps) but the write has not settled.
        await fs.write('pages', 'B.md', '---\ntitle: B\n---\nb, mid-write')
        const second = await scanGraph(adapter, {
            previous: first,
            writeInFlight: (subdir, fileName) => subdir === 'pages' && fileName === 'B.md',
        })

        expect(reads).toEqual([])
        expect(second.find((e) => e.key === 'b')).toBe(before)
        expect(before.size).toBe(new TextEncoder().encode('---\ntitle: B\n---\nb').length)
    })

    it('still reads a file with a write in flight when no previous entry stands for it', async () => {
        const fs = createMemoryDirectoryAdapter({ now: clock(), seed })
        const { adapter, reads } = countingReads(fs)
        const first = await scanGraph(adapter)

        reads.length = 0
        await fs.write('pages', 'C.md', '---\ntitle: C\n---\nc')
        const second = await scanGraph(adapter, { previous: first, writeInFlight: () => true })

        expect(reads).toEqual(['pages/C.md'])
        expect(second.map((e) => e.key)).toEqual(['2026-09-22', 'a', 'b', 'c'])
    })
})
