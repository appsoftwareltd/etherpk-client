import { describe, expect, it } from 'vitest'

import { isImageTarget } from './image-target'

describe('isImageTarget', () => {
    it('accepts an image extension, in an asset reference or a url, whatever the case', () => {
        expect(isImageTarget('../assets/diagram.a1b2c3d4.png')).toBe(true)
        expect(isImageTarget('https://example.com/x.JPG')).toBe(true)
        expect(isImageTarget('assets/pic.webp?v=2#frag')).toBe(true)
    })

    it('refuses a document extension — the shape an import writes for an attachment', () => {
        expect(
            isImageTarget('../assets/benefit-summary-maidenhead-new-1666262450270-0-40fdc1ab.02a0f4ec-4025-450b-8bd9-042f184c36ef.pdf'),
        ).toBe(false)
        expect(isImageTarget('../assets/notes.docx')).toBe(false)
        expect(isImageTarget('https://example.com/report.pdf?download=1')).toBe(false)
    })

    it('treats a url with no file extension as an image — the common shape of a hosted picture', () => {
        expect(isImageTarget('https://picsum.photos/200')).toBe(true)
        expect(isImageTarget('https://example.com')).toBe(true) // `.com` is the host, not an extension
        expect(isImageTarget('https://example.com/img?id=1.5')).toBe(true) // the query is not a path
    })

    it('always accepts inline data and blob urls', () => {
        expect(isImageTarget('data:image/png;base64,iVBORw0KGgo=')).toBe(true)
        expect(isImageTarget('blob:https://app/1234')).toBe(true)
    })

    it('reads a dotfile name as having no extension', () => {
        expect(isImageTarget('assets/.hidden')).toBe(true)
    })
})
