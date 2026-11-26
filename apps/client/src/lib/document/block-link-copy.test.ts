import { afterEach, describe, expect, it, vi } from 'vitest'

// A Native App's own origin (`app://etherpk`, or the address Android answers inside the app) leads
// nowhere outside the app, so a copied Block link must be one the app opens from another program.
const state = vi.hoisted(() => ({ installed: false }))
vi.mock('#lib/native/bridge.js', () => ({ isNativeApp: () => state.installed }))

import { blockLinkAddress } from './block-link-copy'
import { parseBlockLink } from './block-link'

afterEach(() => {
    state.installed = false
})

describe('blockLinkAddress in a Native App', () => {
    const link = { document: 'Garden', line: 2, fingerprint: 'abcdef012345' }

    it('is an etherpk: link that opens the app at the Block, never the app’s own origin', () => {
        state.installed = true
        const address = blockLinkAddress(link, { origin: 'app://etherpk', pathname: '/graph/sync/abc/d/Kitchen' })
        expect(address).toBe('etherpk:/graph/sync/abc/d/Garden#block=2-abcdef012345')
        expect(parseBlockLink(address ?? '')).toEqual(link)
    })

    it('is still none outside a graph', () => {
        state.installed = true
        expect(blockLinkAddress(link, { origin: 'app://etherpk', pathname: '/graphs' })).toBeNull()
    })
})

describe('blockLinkAddress in a browser', () => {
    it("is the Client's own address of the Block, on the graph it has open", () => {
        const link = { document: 'Garden', line: 2, fingerprint: 'abcdef012345' }
        expect(blockLinkAddress(link, { origin: 'https://client.example', pathname: '/graph/sync/abc/d/Kitchen' })).toBe(
            'https://client.example/graph/sync/abc/d/Garden#block=2-abcdef012345',
        )
        expect(blockLinkAddress(link, { origin: 'https://client.example', pathname: '/graphs' })).toBeNull()
    })
})
