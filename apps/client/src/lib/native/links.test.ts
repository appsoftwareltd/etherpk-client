import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'

vi.mock('$app/navigation', () => ({ goto: vi.fn() }))

import { externalAddress } from './links'

const ORIGINS = ['https://installed.app.etherpk.com', 'app://etherpk']

describe('which addresses a Native App hands to the system', () => {
    it.each(ORIGINS)('on %s, every other site, and mail and phone addresses', (origin) => {
        expect(externalAddress('https://example.com/a?b#c', origin)).toBe('https://example.com/a?b#c')
        expect(externalAddress('http://localhost:3000/', origin)).toBe('http://localhost:3000/')
        expect(externalAddress('mailto:someone@example.com', origin)).toBe('mailto:someone@example.com')
        expect(externalAddress('tel:+441234567890', origin)).toBe('tel:+441234567890')
    })

    it.each(ORIGINS)('on %s, none of the app’s own pages', (origin) => {
        for (const href of ['/graphs', `${origin}/graphs`, origin, '#heading', '?a=1', 'graph/sync/x']) expect(externalAddress(href, origin)).toBeNull()
    })

    it.each(ORIGINS)('on %s, nothing that runs or reads here', (origin) => {
        for (const href of ['javascript:alert(1)', 'data:text/html,x', 'blob:https://example.com/1', 'file:///etc/hosts', 'etherpk:/graphs', 'about:blank', '', 'https://']) {
            expect(externalAddress(href, origin)).toBeNull()
        }
    })

    it('is not taken in by an address that only starts like the app’s own', () => {
        expect(externalAddress('https://installed.app.etherpk.com.example.com/', ORIGINS[0])).toBe('https://installed.app.etherpk.com.example.com/')
        expect(externalAddress('https://installed.app.etherpk.com@example.com/', ORIGINS[0])).toContain('example.com')
    })

    it('only ever answers with an address the shell opens', () => {
        fc.assert(
            fc.property(fc.oneof(fc.webUrl({ withFragments: true, withQueryParameters: true }), fc.string(), fc.string().map((text) => `x:${text}`)), fc.constantFrom(...ORIGINS), (href, origin) => {
                const external = externalAddress(href, origin)
                if (external !== null) expect(['http:', 'https:', 'mailto:', 'tel:']).toContain(new URL(external).protocol)
            }),
            { seed: 20261125, numRuns: 500 },
        )
    })
})
