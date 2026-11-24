import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { renderForPrint } from './render-for-print'

/**
 * A document as it prints (render-for-print.ts), over text made of everything the format has and of
 * markup meant to break out of it: only the tags the renderer writes come out, no link leads
 * anywhere but the web, and no wikilink's brackets are left.
 */

function runs(fallback: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? fallback), seed: seed === undefined ? 20261124 : Number(seed) }
}

const piece = fc.constantFrom(
    'beans', ' ', '\n', '\n\n', '- ', '  - ', '# ', '> ', '`code`', '**bold**', '[[Kitchen]]', '[[[[Garden]] Notes]]', '[[', ']]', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>',
    '<svg><script>1</script></svg>', '</p>', '<!-- x -->', '&lt;', '[seeds](https://example.com)', '[run](javascript:alert(1))', '[notes](../pages/Notes.md)', '![pond](../assets/pond.png)', '![x](data:text/html,1)',
    '```\n', '```js\n', '```excalidraw.drawing\n', '```map\n', '```mermaid\n', '| a | b |\n| - | - |\n', '- [ ] #P1 ', '$x^2$', '==mark==', '"', "'", '\\',
)
const ALLOWED = new Set('h1 h2 h3 h4 h5 h6 p ul ol li a img em strong s code pre blockquote table thead tbody tr th td hr br mark span input figure figcaption div section sup'.split(' '))

describe('whatever a document holds', () => {
    it('prints as the renderer\'s own tags, with no link off the web and no wikilink brackets', async () => {
        await fc.assert(
            fc.asyncProperty(fc.array(piece, { maxLength: 25 }), async (pieces) => {
                const { html } = await renderForPrint({ name: 'Garden', text: pieces.join('') }, {})
                for (const [, tag] of html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)) {
                    // KaTeX writes MathML, which has no way to run or load anything.
                    if (/^(math|semantics|mrow|m[a-z]+|annotation)$/.test(tag)) continue
                    expect([...ALLOWED]).toContain(tag.toLowerCase())
                }
                expect(html).not.toMatch(/<[^>]*\son[a-z]+\s*=/i)
                expect(html).not.toMatch(/href="\s*javascript:/i)
                expect(html).not.toContain('class="wikilink')
            }),
            runs(400),
        )
    })
})
