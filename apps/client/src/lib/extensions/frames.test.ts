import { describe, expect, it } from 'vitest'

import { allowedFrameAddress, FRAME_REFERRER_POLICY, frameAttributes } from './frames'

describe('the frames an extension may show (ADR 0137)', () => {
    it("allows the two video players' hosts", () => {
        expect(allowedFrameAddress('https://www.youtube-nocookie.com/embed/abcdefghijk?start=90')).toBe('https://www.youtube-nocookie.com/embed/abcdefghijk?start=90')
        expect(allowedFrameAddress('https://player.vimeo.com/video/123456?h=abc')).toBe('https://player.vimeo.com/video/123456?h=abc')
    })

    it('refuses every other address, the app itself and its object URLs included', () => {
        for (const src of [
            'https://www.youtube.com/embed/abcdefghijk',
            'http://player.vimeo.com/video/1',
            'https://player.vimeo.com.example.com/video/1',
            'https://user:secret@player.vimeo.com/video/1',
            'blob:https://app.example.com/1',
            '/g/graph/d/Garden',
            'javascript:alert(1)',
            'not a link',
        ]) {
            expect(allowedFrameAddress(src)).toBeNull()
        }
    })

    it('gives a frame the referrer YouTube needs, a sandbox, lazy loading and a title', () => {
        const attributes = frameAttributes({ src: 'https://www.youtube-nocookie.com/embed/abcdefghijk', title: 'Garden tour' })
        expect(attributes.referrerpolicy).toBe(FRAME_REFERRER_POLICY)
        expect(attributes.sandbox.split(' ')).toEqual(expect.arrayContaining(['allow-scripts', 'allow-same-origin']))
        expect(attributes.sandbox).not.toContain('allow-top-navigation')
        expect(attributes.loading).toBe('lazy')
        expect(attributes.title).toBe('Garden tour')
    })

    it('throws for a host it does not allow, and for a frame with no title', () => {
        expect(() => frameAttributes({ src: 'https://example.com/', title: 'Kitchen' })).toThrow(/only from/)
        expect(() => frameAttributes({ src: 'https://player.vimeo.com/video/1', title: '  ' })).toThrow(/title/)
    })
})
