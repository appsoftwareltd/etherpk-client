import { describe, expect, it } from 'vitest'

import { highlightCode } from './highlight'

describe('highlightCode', () => {
    it('highlights a language the editor knows with the classHighlighter names', async () => {
        const html = await highlightCode('js', 'const x = "a" // hi\n')
        expect(html).toContain('<span class="tok-keyword">const</span>')
        expect(html).toContain('<span class="tok-string">&quot;a&quot;</span>')
        expect(html).toContain('<span class="tok-comment">// hi</span>')
        expect(html?.endsWith('\n')).toBe(true)
    })

    it('finds a language by alias and escapes the text', async () => {
        const html = await highlightCode('ts', 'let a: string = "<b>"')
        expect(html).toContain('&lt;b&gt;')
        expect(html).toContain('tok-keyword')
    })

    it('is null for an unknown language or none', async () => {
        expect(await highlightCode('no-such-language', 'x')).toBeNull()
        // A plain-text block stays plain: LaTeX's alias `tex` inside the word does not count.
        expect(await highlightCode('text', '50% done')).toBeNull()
        expect(await highlightCode('plaintext', '50% done')).toBeNull()
        expect(await highlightCode('', 'x')).toBeNull()
    })
})
