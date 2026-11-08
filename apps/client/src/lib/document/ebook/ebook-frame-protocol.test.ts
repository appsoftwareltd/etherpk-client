import { describe, expect, it } from 'vitest'

import { readFrameMessage } from './ebook-frame-protocol'

const CFI = 'epubcfi(/6/4!/4/2:12)'

describe('what the app accepts from the page an EBook reads in', () => {
    it('ignores anything that is not a message it knows', () => {
        for (const raw of [null, 'text', 4, {}, { type: 'nonsense' }, { type: 'constructor' }, { type: '__proto__' }]) {
            expect(readFrameMessage(raw)).toBeNull()
        }
    })

    it('needs a real place in an EBook to accept a move', () => {
        expect(readFrameMessage({ type: 'relocate', cfi: 'javascript:alert(1)', fraction: 0.5 })).toBeNull()
        expect(readFrameMessage({ type: 'relocate', cfi: CFI, fraction: 'half' })).toBeNull()
        expect(readFrameMessage({ type: 'relocate', cfi: CFI, fraction: 7 })).toMatchObject({ cfi: CFI, fraction: 1 })
        expect(readFrameMessage({ type: 'relocate', cfi: CFI, fraction: 0.5, backTo: 0.22 })).toMatchObject({ backTo: 0.22 })
        expect(readFrameMessage({ type: 'relocate', cfi: CFI, fraction: 0.5, backTo: 'start' })).toMatchObject({ backTo: null })
        expect(readFrameMessage({ type: 'relocate', cfi: CFI, fraction: 0.5 })).toMatchObject({ backTo: null })
    })

    it('accepts a place that names an element with a space in its id', () => {
        const cfi = 'epubcfi(/4/2[Chapter 1]/4[plain],/1:0,/1:4)'
        expect(readFrameMessage({ type: 'relocate', cfi, fraction: 0.5 })).toMatchObject({ cfi })
        expect(readFrameMessage({ type: 'selection', text: 'beans', cfi, fraction: 0.5 })).toMatchObject({ cfi })
    })

    it('cuts text to size', () => {
        const message = readFrameMessage({ type: 'selection', text: 'x'.repeat(50_000), cfi: CFI, chapter: null, fraction: 0.1 })
        expect(message?.type === 'selection' && message.text.length).toBe(20_000)
    })

    it('drops a selection place that is not one, and keeps the words', () => {
        expect(readFrameMessage({ type: 'selection', text: 'beans', cfi: '<img>', fraction: 0 })).toMatchObject({ text: 'beans', cfi: null })
    })

    it('accepts only ordinary addresses for a link out of an EBook', () => {
        expect(readFrameMessage({ type: 'externalLink', href: 'https://example.com/beans' })).toEqual({ type: 'externalLink', href: 'https://example.com/beans' })
        expect(readFrameMessage({ type: 'externalLink', href: 'mailto:sidney@example.com' })).not.toBeNull()
        for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'blob:null/1', '']) {
            expect(readFrameMessage({ type: 'externalLink', href })).toBeNull()
        }
    })

    it('keeps the good entries of a damaged contents list', () => {
        const message = readFrameMessage({ type: 'opened', title: 'Garden Notes', toc: [{ label: 'Beans', href: 'c0.xhtml', depth: 0 }, { label: 3 }, null, { label: 'Deep', href: 'c1.xhtml', depth: 99 }] })
        expect(message?.type === 'opened' && message.toc).toEqual([
            { label: 'Beans', href: 'c0.xhtml', depth: 0 },
            { label: 'Deep', href: 'c1.xhtml', depth: 8 },
        ])
    })

    it('never takes a key press with a long name', () => {
        expect(readFrameMessage({ type: 'key', key: 'x'.repeat(100) })).toMatchObject({ key: 'x'.repeat(40) })
        expect(readFrameMessage({ type: 'key', key: '' })).toBeNull()
    })
})
