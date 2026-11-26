import { describe, expect, it } from 'vitest'

import {
    blockFingerprintAt,
    blockFingerprintOf,
    blockLinkUrl,
    blockWords,
    findBlock,
    parseBlockLink,
    resolveBlockLink,
    type BlockLinkSources,
} from './block-link'

const GARDEN = ['# Garden', '- Beds', '  - Comments', '    - water the beans', '- Shed', '  - Comments', '    - oil the hinge']

describe('blockWords', () => {
    it('reads a bullet’s words without its marker, checkbox or task tags', () => {
        expect(blockWords('  - water   the beans')).toBe('water the beans')
        expect(blockWords('- [ ] #P1 #D water the beans')).toBe('water the beans')
        expect(blockWords('- [x] #P1 water the beans')).toBe('water the beans')
    })
})

describe('blockFingerprintAt', () => {
    it('is twelve hex characters for a bullet and null for anything else', async () => {
        expect(await blockFingerprintAt(GARDEN, 1)).toMatch(/^[0-9a-f]{12}$/)
        expect(await blockFingerprintAt(GARDEN, 0)).toBeNull()
        expect(await blockFingerprintAt(['```', '- not a bullet', '```'], 1)).toBeNull()
    })

    it('is the same read from a line and its parent alone', async () => {
        expect(await blockFingerprintOf('    - water the beans', '  - Comments')).toBe(await blockFingerprintAt(GARDEN, 3))
        expect(await blockFingerprintOf('- Beds', null)).toBe(await blockFingerprintAt(GARDEN, 1))
    })

    it('tells apart bullets with the same words under different parents', async () => {
        expect(await blockFingerprintAt(GARDEN, 2)).not.toBe(await blockFingerprintAt(GARDEN, 5))
    })

    it('keeps its words half while a task’s state or tags change', async () => {
        const open = await blockFingerprintAt(['- [ ] #P1 water the beans'], 0)
        const done = await blockFingerprintAt(['- [x] #P2 water the beans'], 0)
        expect(open).toBe(done)
    })
})

describe('parseBlockLink and blockLinkUrl', () => {
    const graph = { where: 'sync', name: 'abc' } as const

    it('round-trips a block link through its address', () => {
        const link = { document: '[[Acme]] Notes', line: 4, fingerprint: '0123456789ab' }
        const url = blockLinkUrl(graph, link, 'https://client.example')
        expect(url).toBe('https://client.example/graph/sync/abc/d/%5B%5BAcme%5D%5D%20Notes#block=4-0123456789ab')
        expect(parseBlockLink(url)).toEqual(link)
    })

    it('reads nothing from an address without a block', () => {
        expect(parseBlockLink('https://client.example/graph/sync/abc/d/Garden')).toBeNull()
        expect(parseBlockLink('https://client.example/graph/sync/abc/d/Garden#block=x-0123456789ab')).toBeNull()
        expect(parseBlockLink('https://client.example/graph/sync/abc/d/Garden#task=3-0123456789ab')).toBeNull()
    })
})

describe('findBlock', () => {
    it('finds the block at its line', async () => {
        const fingerprint = (await blockFingerprintAt(GARDEN, 5))!
        expect(await findBlock(GARDEN, 5, fingerprint)).toEqual({ line: 5, foundBy: 'at_line' })
    })

    it('finds the block where lines added above have moved it', async () => {
        const fingerprint = (await blockFingerprintAt(GARDEN, 5))!
        const later = ['- Gate', ...GARDEN]
        expect(await findBlock(later, 5, fingerprint)).toEqual({ line: 6, foundBy: 'moved' })
    })

    it('takes the match nearest the line when several blocks have the same words and parent', async () => {
        const lines = ['- Beds', '  - Comments', '- Shed', '- Path', '- Beds', '  - Comments']
        const fingerprint = (await blockFingerprintAt(lines, 5))!
        expect(await findBlock(['- Gate', ...lines], 5, fingerprint)).toEqual({ line: 6, foundBy: 'moved' })
    })

    it('finds a block whose parent was edited by its own words', async () => {
        const fingerprint = (await blockFingerprintAt(GARDEN, 3))!
        const edited = GARDEN.map((line) => (line === '  - Comments' ? '  - Notes' : line))
        expect(await findBlock(edited, 3, fingerprint)).toEqual({ line: 3, foundBy: 'at_line' })
        expect(await findBlock(['- Gate', ...edited], 3, fingerprint)).toEqual({ line: 4, foundBy: 'moved' })
    })

    it('finds a block whose own words were edited by its parent, only at its line', async () => {
        const fingerprint = (await blockFingerprintAt(GARDEN, 3))!
        const edited = GARDEN.map((line) => (line === '    - water the beans' ? '    - water the peas' : line))
        expect(await findBlock(edited, 3, fingerprint)).toEqual({ line: 3, foundBy: 'at_line' })
        expect(await findBlock(['- Gate', ...edited], 3, fingerprint)).toBeNull()
    })

    it('finds nothing once the block is gone', async () => {
        const fingerprint = (await blockFingerprintAt(GARDEN, 6))!
        expect(await findBlock(GARDEN.slice(0, 6), 6, fingerprint)).toBeNull()
    })
})

describe('resolveBlockLink', () => {
    function sources(bodies: Record<string, string>): BlockLinkSources {
        return {
            resolveDocument: (name) => Object.keys(bodies).find((key) => key.toLowerCase() === name.toLowerCase()) ?? null,
            readBody: async (document) => bodies[document] ?? null,
            allBullets: async () =>
                Object.entries(bodies).flatMap(([document, body]) =>
                    body.split('\n').flatMap((text, line) => (text.trimStart().startsWith('- ') ? [{ document, line, label: text.trimStart().slice(2) }] : [])),
                ),
        }
    }

    it('finds the block in its own document', async () => {
        const fingerprint = (await blockFingerprintAt(GARDEN, 4))!
        const found = await resolveBlockLink({ document: 'garden', line: 4, fingerprint }, sources({ Garden: GARDEN.join('\n') }))
        expect(found).toEqual({ ok: true, document: 'Garden', line: 4, foundBy: 'at_line' })
    })

    it('follows a block cut into another document', async () => {
        const fingerprint = (await blockFingerprintAt(GARDEN, 4))!
        const found = await resolveBlockLink(
            { document: 'Garden', line: 4, fingerprint },
            sources({ Garden: '# Garden\n- Beds', Kitchen: '- Pantry\n- Shed\n  - Comments\n    - oil the hinge' }),
        )
        expect(found).toEqual({ ok: true, document: 'Kitchen', line: 1, foundBy: 'other_document' })
    })

    it('says so when it cannot tell which document holds the block', async () => {
        const fingerprint = (await blockFingerprintAt(GARDEN, 4))!
        const found = await resolveBlockLink({ document: 'Garden', line: 4, fingerprint }, sources({ Garden: '- Beds', Kitchen: '- Shed', Hall: '- Shed' }))
        expect(found).toEqual({ ok: false, code: 'block_ambiguous' })
    })

    it('says so when the block is nowhere', async () => {
        const fingerprint = (await blockFingerprintAt(GARDEN, 4))!
        const found = await resolveBlockLink({ document: 'Garden', line: 4, fingerprint }, sources({ Garden: '- Beds' }))
        expect(found).toEqual({ ok: false, code: 'block_not_found' })
    })
})
