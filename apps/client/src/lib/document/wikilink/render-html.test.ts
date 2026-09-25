import { describe, expect, it } from 'vitest'

import { renderWikilinkSegmentsToHtml } from './render-html'
import { createSlugResolver } from './resolver'
import { wikilinkSegmentsInSource } from './source'

const render = (src: string, resolver = createSlugResolver()) =>
    renderWikilinkSegmentsToHtml(src, wikilinkSegmentsInSource(src), resolver)

describe('renderWikilinkSegmentsToHtml', () => {
    it('renders a simple link as one anchor to its slug', () => {
        expect(render('[[My Page]]')).toBe('<a href="my-page.html" class="wikilink">My Page</a>')
    })

    it('renders a scoped concept as chained sibling anchors, dropping the empty leading segment', () => {
        expect(render('[[[[Physics]] Quantum Mechanics]]')).toBe(
            '<a href="physics.html" class="wikilink">Physics</a>' +
                '<a href="physics-quantum-mechanics.html" class="wikilink"> Quantum Mechanics</a>',
        )
    })

    it('marks a non-public/missing target and points it at 404, leaving siblings intact', () => {
        // Only the inner scope (Physics) is public; the outer scoped concept is not.
        const resolver = createSlugResolver(['Physics'])
        expect(render('[[[[Physics]] Quantum Mechanics]]', resolver)).toBe(
            '<a href="physics.html" class="wikilink">Physics</a>' +
                '<a href="404.html" class="wikilink-missing"> Quantum Mechanics</a>',
        )
    })

    it('escapes HTML in the display text', () => {
        expect(render('[[a<b>&c]]')).toContain('>a&lt;b&gt;&amp;c<')
    })
})
