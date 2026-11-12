import { describe, expect, it } from 'vitest'

import { noteTextWithFiles, quickNoteAssetRefs, quickNoteParts } from './quick-note-files'

const photo = { ref: '../assets/receipt.a1b2c3d4.webp', stem: 'receipt', isImage: true }
const pdf = { ref: '../assets/report.e5f6a7b8.pdf', stem: 'report', isImage: false }

describe('noteTextWithFiles', () => {
    it('puts each file on a line of its own after the text', () => {
        expect(noteTextWithFiles(' corner shop ', [photo, pdf])).toBe(
            'corner shop\n![receipt](../assets/receipt.a1b2c3d4.webp)\n[report](../assets/report.e5f6a7b8.pdf)',
        )
    })

    it('is the reference alone for a note with no text', () => {
        expect(noteTextWithFiles('', [photo])).toBe('![receipt](../assets/receipt.a1b2c3d4.webp)')
    })

    it("gives a picture the graph's display size and a file none", () => {
        expect(noteTextWithFiles('', [photo, pdf], '300')).toBe(
            '![receipt|300](../assets/receipt.a1b2c3d4.webp)\n[report](../assets/report.e5f6a7b8.pdf)',
        )
    })

    it('is the text alone with no files', () => {
        expect(noteTextWithFiles('beans', [])).toBe('beans')
    })
})

describe('quickNoteParts', () => {
    it('is one text part for a note with no files, line breaks kept', () => {
        expect(quickNoteParts('beans\nand bread')).toEqual([{ kind: 'text', text: 'beans\nand bread' }])
    })

    it('reads a picture line and a file line as parts of their own', () => {
        expect(quickNoteParts('corner shop\n![receipt|300](../assets/receipt.a1b2c3d4.webp)\n[report](../assets/report.e5f6a7b8.pdf)')).toEqual([
            { kind: 'text', text: 'corner shop' },
            { kind: 'image', url: '../assets/receipt.a1b2c3d4.webp', alt: 'receipt|300' },
            { kind: 'file', url: '../assets/report.e5f6a7b8.pdf', name: 'report.pdf' },
        ])
    })

    it('leaves a link in a sentence, and a link to a web page, as text', () => {
        const text = 'see [report](../assets/report.e5f6a7b8.pdf) today\n[Growing beans](https://example.com/beans)'
        expect(quickNoteParts(text)).toEqual([{ kind: 'text', text }])
    })
})

describe('quickNoteAssetRefs', () => {
    it('names each asset a note references once, wherever it is written', () => {
        const text = 'see [report](../assets/report.e5f6a7b8.pdf)\n![receipt](../assets/receipt.a1b2c3d4.webp)\n[report](../assets/report.e5f6a7b8.pdf)\n[web](https://example.com/)'
        expect(quickNoteAssetRefs(text)).toEqual(['../assets/report.e5f6a7b8.pdf', '../assets/receipt.a1b2c3d4.webp'])
    })
})
