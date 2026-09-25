import { parser } from '@lezer/markdown'
import { describe, expect, it } from 'vitest'

import { editorMarkdownExtensions } from './scheme-url-autolink'

const markdown = parser.configure(editorMarkdownExtensions)

/** Every `URL` node's text, in document order. */
function urls(doc: string): string[] {
    const out: string[] = []
    markdown.parse(doc).iterate({
        enter(node) {
            if (node.name === 'URL') out.push(doc.slice(node.from, node.to))
        },
    })
    return out
}

describe('the bare-url parser', () => {
    it('links a dotless http host GFM declines', () => {
        expect(urls('see http://localhost:5174/g/x now')).toEqual(['http://localhost:5174/g/x'])
    })

    it('links a bare file url, whitespace-terminated', () => {
        expect(urls('the report is at file:///home/g/Report%20Q3.pdf today')).toEqual(['file:///home/g/Report%20Q3.pdf'])
        expect(urls('on Windows file:///C:/Users/g/x.txt too')).toEqual(['file:///C:/Users/g/x.txt'])
        expect(urls('and file://server/share/x')).toEqual(['file://server/share/x'])
    })

    it('leaves trailing punctuation and an unbalanced paren out of a file url', () => {
        expect(urls('see file:///home/g/notes.')).toEqual(['file:///home/g/notes'])
        expect(urls('(see file:///home/g/notes)')).toEqual(['file:///home/g/notes'])
    })

    it('does not link a file url with no path, nor one mid-word, nor one in code', () => {
        expect(urls('file:// alone')).toEqual([])
        expect(urls('file:/// alone')).toEqual([])
        expect(urls('profile:///x')).toEqual([])
        expect(urls('`file:///home/g/x`')).toEqual([])
    })
})
