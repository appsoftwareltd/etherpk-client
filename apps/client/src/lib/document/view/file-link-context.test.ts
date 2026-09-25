import { markdown } from '@codemirror/lang-markdown'
import { describe, expect, it } from 'vitest'

import { editorMarkdownExtensions } from './augmentations/scheme-url-autolink'
import { fileLinkAtCaret, fileLinkForCaret } from './file-link-context'
import { editorFixture as bareFixture } from './testing/editor-state-fixture'

/** The fixture with the editor's markdown language loaded: the context reads the syntax tree. */
const editorFixture = (text: string) => bareFixture(text, { extensions: [markdown({ extensions: editorMarkdownExtensions, addKeymap: false })] })

describe('fileLinkAtCaret', () => {
    it('finds the file link the caret sits in, in any shape', () => {
        expect(fileLinkAtCaret(editorFixture('- see file:///home/g/x.pdf| now').state)?.path).toBe('/home/g/x.pdf')
        expect(fileLinkAtCaret(editorFixture('- see file:///home/|g/x.pdf now').state)?.path).toBe('/home/g/x.pdf')
        expect(fileLinkAtCaret(editorFixture('- [the| report](file:///C:/Users/g/q3.docx)').state)?.path).toBe('C:\\Users\\g\\q3.docx')
        expect(fileLinkAtCaret(editorFixture('- <file:///home/g/x|.pdf>').state)?.path).toBe('/home/g/x.pdf')
    })

    it('is null beside a link, on a hyperlink, and in code', () => {
        expect(fileLinkAtCaret(editorFixture('- se|e file:///home/g/x.pdf now').state)).toBeNull()
        expect(fileLinkAtCaret(editorFixture('- see https://example.com/x| now').state)).toBeNull()
        expect(fileLinkAtCaret(editorFixture('- `file:///home/g/x|.pdf`').state)).toBeNull()
    })
})

describe('fileLinkForCaret', () => {
    it('is the link at the caret when there is one', () => {
        expect(fileLinkForCaret(editorFixture('- a file:///x.pdf and file:///y|.pdf').state)?.path).toBe('/y.pdf')
    })

    it('else the nearest link before the caret on the line (where a / menu query has just been typed)', () => {
        expect(fileLinkForCaret(editorFixture('- a file:///x.pdf and file:///y.pdf /copy|').state)?.path).toBe('/y.pdf')
        expect(fileLinkForCaret(editorFixture('- a file:///x.pdf here| and file:///y.pdf').state)?.path).toBe('/x.pdf')
    })

    it('else the first on the line, and null when the line holds none', () => {
        expect(fileLinkForCaret(editorFixture('- se|e file:///x.pdf').state)?.path).toBe('/x.pdf')
        expect(fileLinkForCaret(editorFixture('- plain| text\n- file:///x.pdf').state)).toBeNull()
    })
})

describe('fileLinkAtCaret spans the whole construct', () => {
    it('counts the url half of a labelled link as inside', () => {
        expect(fileLinkAtCaret(editorFixture('- [the report](file:///C:/Users/g/q3|.docx)').state)?.path).toBe('C:\\Users\\g\\q3.docx')
    })
})
