import { describe, expect, it } from 'vitest'

import { checkedFenceAnswer } from './fence-answer'

// What an extension's `publish` or `quote` answered, checked one way for both readers: the publisher
// and the reference lists (ADR 0146).

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const picture = (overrides: Record<string, unknown> = {}) => ({ kind: 'picture', type: 'image/png', bytes: PNG, width: 320, height: 180, alt: 'Beds in the garden', ...overrides })

describe("checking an extension's answer for a fence", () => {
    it('passes nothing on as nothing', () => {
        expect(checkedFenceAnswer(null)).toBeNull()
    })

    it('keeps a PNG, WebP or SVG picture with its size and words', () => {
        for (const type of ['image/png', 'image/webp', 'image/svg+xml']) {
            expect(checkedFenceAnswer(picture({ type }))).toEqual(picture({ type }))
        }
    })

    it('refuses a picture of any other type, or with no bytes', () => {
        expect(() => checkedFenceAnswer(picture({ type: 'image/gif' }))).toThrow('not an SVG, PNG or WebP file')
        expect(() => checkedFenceAnswer(picture({ bytes: 'abc' }))).toThrow('not an SVG, PNG or WebP file')
    })

    it('refuses a picture with no size to reserve', () => {
        expect(() => checkedFenceAnswer(picture({ width: 0 }))).toThrow('no size')
        expect(() => checkedFenceAnswer(picture({ height: Number.NaN }))).toThrow('no size')
        expect(() => checkedFenceAnswer(picture({ width: '320' }))).toThrow('no size')
    })

    it('copies the bytes, so the extension changing its own array later changes nothing shown', () => {
        const bytes = new Uint8Array([1, 2, 3])
        const checked = checkedFenceAnswer(picture({ bytes }))
        bytes[0] = 9
        expect(checked).toMatchObject({ bytes: new Uint8Array([1, 2, 3]) })
    })

    it('reads each part of the answer once, so a part that changes as it is read is judged as it was kept', () => {
        let reads = 0
        const answer = {
            kind: 'picture',
            width: 320,
            height: 180,
            alt: 'Beds',
            get type() {
                reads++
                return reads === 1 ? 'image/png' : 'text/html'
            },
            get bytes() {
                return PNG
            },
        }
        expect(checkedFenceAnswer(answer)).toMatchObject({ type: 'image/png' })
        expect(reads).toBe(1)
    })

    it('keeps a link to an https address, with its picture from an https address', () => {
        const link = { kind: 'link', href: 'https://garden.example/plot', text: 'The plot', image: { src: 'https://garden.example/plot.jpg', alt: 'The plot from above', width: 480, height: 360 } }
        expect(checkedFenceAnswer(link)).toEqual(link)
    })

    it('refuses a link anywhere else, and leaves out a picture from anywhere else', () => {
        expect(() => checkedFenceAnswer({ kind: 'link', href: 'javascript:alert(1)', text: 'The plot' })).toThrow('not an https address')
        expect(checkedFenceAnswer({ kind: 'link', href: 'https://garden.example/plot', text: 'The plot', image: { src: 'http://garden.example/plot.jpg', alt: 'The plot' } })).toEqual({
            kind: 'link',
            href: 'https://garden.example/plot',
            text: 'The plot',
        })
    })

    it("keeps a link's picture size only when both sides are given", () => {
        const checked = checkedFenceAnswer({ kind: 'link', href: 'https://garden.example/plot', text: 'The plot', image: { src: 'https://garden.example/plot.jpg', alt: 'The plot', width: 480 } })
        expect(checked).toEqual({ kind: 'link', href: 'https://garden.example/plot', text: 'The plot', image: { src: 'https://garden.example/plot.jpg', alt: 'The plot' } })
    })

    it("names a link by its address when it has no text", () => {
        expect(checkedFenceAnswer({ kind: 'link', href: 'https://garden.example/plot' })).toEqual({ kind: 'link', href: 'https://garden.example/plot', text: 'https://garden.example/plot' })
    })

    it('refuses anything that is neither a picture nor a link, a missing answer among them', () => {
        expect(() => checkedFenceAnswer({ kind: 'html', html: '<b>beds</b>' })).toThrow('neither a picture nor a link')
        expect(() => checkedFenceAnswer(undefined)).toThrow('neither a picture nor a link')
        expect(() => checkedFenceAnswer('beds')).toThrow('neither a picture nor a link')
    })
})
