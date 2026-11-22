import { describe, expect, it } from 'vitest'

import { type SearchMatch, searchFolder } from './folder-search'
import { createMemoryTreeAdapter } from './memory-tree-adapter'

const tree = () =>
    createMemoryTreeAdapter({
        now: () => 1,
        seed: {
            'README.md': '# Garden\r\nWater the Beans daily.\r\n',
            'guide/watering.md': 'Beds by the fence.\nbeans need water. Beans again.\n',
            'guide/bed.png': 'beans in bytes',
            'menu.txt': new Uint8Array([0x62, 0x65, 0x61, 0x6e, 0x73, 0xe9]),
            'sizes.csv': 'bed,beans\n',
        },
    })
const FILES = ['README.md', 'guide/bed.png', 'guide/watering.md', 'menu.txt', 'sizes.csv']

async function search(query: string, limit?: number, signal?: AbortSignal) {
    const matches: SearchMatch[] = []
    const outcome = await searchFolder(tree(), FILES, query, { onMatch: (match) => matches.push(match), limit, signal })
    return { matches, outcome }
}

describe('Search in folder', () => {
    it('finds text in every text file, whatever its case and line endings, one match to a line', async () => {
        const { matches, outcome } = await search('beans')
        expect(matches.map((match) => `${match.path}:${match.line}`)).toEqual(['README.md:1', 'guide/watering.md:1', 'sizes.csv:0'])
        expect(matches[0]).toEqual({ path: 'README.md', line: 1, text: 'Water the Beans daily.', from: 10, to: 15 })
        // The picture is not read, and the file that is not UTF-8 is read and passed over.
        expect(outcome).toEqual({ filesRead: 4, truncated: false, aborted: false })
    })

    it('cuts a long line around the match and says where the match is in what is left', async () => {
        const long = `${'a'.repeat(100)} beans ${'b'.repeat(100)}`
        const matches: SearchMatch[] = []
        await searchFolder(createMemoryTreeAdapter({ now: () => 1, seed: { 'long.md': long } }), ['long.md'], 'beans', { onMatch: (match) => matches.push(match) })
        expect(matches[0].text.startsWith('…')).toBe(true)
        expect(matches[0].text.endsWith('…')).toBe(true)
        expect(matches[0].text.slice(matches[0].from, matches[0].to)).toBe('beans')
    })

    it('stops at its limit, when it is told to, and for a query of nothing', async () => {
        expect((await search('beans', 2)).outcome).toMatchObject({ truncated: true })
        expect((await search('beans', 2)).matches).toHaveLength(2)
        const stopped = new AbortController()
        stopped.abort()
        expect(await search('beans', undefined, stopped.signal)).toEqual({ matches: [], outcome: { filesRead: 0, truncated: false, aborted: true } })
        expect((await search('  ')).matches).toEqual([])
    })
})
