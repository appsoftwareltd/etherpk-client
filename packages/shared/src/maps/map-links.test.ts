import { describe, expect, it } from 'vitest'

import { isShortMapLink, mapLinkRequestSchema } from './map-links'

// The short links a Sync Server opens for a Client (ADR 0119, amendment of 2026-10-10): Google's
// share links only, which a browser page cannot follow itself. A Sync Server follows nothing else,
// so it never becomes a way to fetch any address someone names.

describe('a short map link', () => {
    it("is one of Google's share links", () => {
        expect(isShortMapLink('https://maps.app.goo.gl/AbCdEf123')).toBe(true)
        expect(isShortMapLink(' https://maps.app.goo.gl/AbCdEf123?g_st=ac ')).toBe(true)
        expect(isShortMapLink('https://goo.gl/maps/AbCdEf123')).toBe(true)
    })

    it("is never another site, another scheme, or another part of Google's", () => {
        expect(isShortMapLink('http://maps.app.goo.gl/AbCdEf123')).toBe(false)
        expect(isShortMapLink('https://maps.app.goo.gl/')).toBe(false)
        expect(isShortMapLink('https://goo.gl/AbCdEf123')).toBe(false)
        expect(isShortMapLink('https://maps.app.goo.gl.example.com/AbCdEf123')).toBe(false)
        expect(isShortMapLink('https://user@maps.app.goo.gl/AbCdEf123')).toBe(false)
        expect(isShortMapLink('https://maps.app.goo.gl:8443/AbCdEf123')).toBe(false)
        expect(isShortMapLink('https://maps.app.goo.gl/a/b')).toBe(false)
        expect(isShortMapLink('https://www.google.com/maps/@50.7486,-4.0789,15z')).toBe(false)
        // OpenStreetMap's hold their position, so the device reads them itself.
        expect(isShortMapLink('https://osm.org/go/euu4XEhK--')).toBe(false)
        expect(isShortMapLink('Garden')).toBe(false)
    })
})

describe('a request to open one', () => {
    it('takes a short map link and nothing else', () => {
        expect(mapLinkRequestSchema.parse({ url: ' https://maps.app.goo.gl/AbCdEf123 ' })).toEqual({ url: 'https://maps.app.goo.gl/AbCdEf123' })
        expect(mapLinkRequestSchema.safeParse({ url: 'https://example.com/AbCdEf123' }).success).toBe(false)
        expect(mapLinkRequestSchema.safeParse({ url: `https://maps.app.goo.gl/${'a'.repeat(300)}` }).success).toBe(false)
        expect(mapLinkRequestSchema.safeParse({ url: 'https://maps.app.goo.gl/AbCdEf123', follow: true }).success).toBe(false)
    })
})
