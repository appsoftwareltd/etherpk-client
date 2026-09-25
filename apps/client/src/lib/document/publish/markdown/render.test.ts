import { describe, expect, it } from 'vitest'

import { createDocumentRenderer, excerptOf } from './render'

const resolve = (concept: string) => {
    const known: Record<string, string> = { physics: 'physics.html', 'quantum mechanics': 'quantum-mechanics.html', '[[physics]] waves': 'physics-waves.html' }
    const href = known[concept.toLowerCase()]
    return href ? { href, missing: false } : { href: '404.html', missing: true }
}

function renderer(extra: Partial<Parameters<typeof createDocumentRenderer>[0]> = {}) {
    return createDocumentRenderer({
        resolve,
        assetHref: (name) => `assets/${encodeURIComponent(name)}`,
        ...extra,
    })
}

describe('createDocumentRenderer', () => {
    it('renders outliner bullets as nested lists', () => {
        const { html } = renderer().render('- parent\n  - child\n    - grandchild\n- sibling\n')
        expect(html.replace(/\n/g, '')).toBe('<ul><li>parent<ul><li>child<ul><li>grandchild</li></ul></li></ul></li><li>sibling</li></ul>')
    })

    it('renders wikilinks as anchors, nested ones as chained siblings, missing ones to the 404 page', () => {
        const { html } = renderer().render('see [[Physics]] and [[[[Physics]] Waves]] and [[Nowhere]]')
        expect(html).toContain('<a href="physics.html" class="wikilink">Physics</a>')
        expect(html).toContain('<a href="physics.html" class="wikilink">Physics</a><a href="physics-waves.html" class="wikilink"> Waves</a>')
        expect(html).toContain('<a href="404.html" class="wikilink-missing">Nowhere</a>')
    })

    it('leaves a wikilink inside code alone', () => {
        const { html } = renderer().render('`[[Physics]]`\n\n```text\n[[Physics]]\n```\n')
        expect(html).not.toContain('<a')
        expect(html).toContain('<code>[[Physics]]</code>')
    })

    it('renders a task as a disabled checkbox with badges for every tag the editor knows', () => {
        const { html } = renderer().render('- [ ] #P1 #D #D-2026-07-01 #S-2026-06-30 Ship it [[Physics]]\n- [x] #C done\n')
        expect(html).toContain('<li class="task"><input type="checkbox" disabled> ')
        expect(html).toContain('<span class="task-tag priority-1">Priority 1</span>')
        expect(html).toContain('<span class="task-tag doing">Doing</span>')
        expect(html).toContain('<span class="task-tag due-date">Due 2026-07-01</span>')
        expect(html).toContain('<span class="task-tag scheduled-date">Scheduled 2026-06-30</span>')
        expect(html).toContain('Ship it <a href="physics.html" class="wikilink">Physics</a>')
        expect(html).toContain('<li class="task done"><input type="checkbox" disabled checked> <span class="task-tag cancelled">Cancelled</span> done')
    })

    it('a `#` mid-sentence is text, not a tag', () => {
        const { html } = renderer().render('- [ ] Ship #P1 later\n')
        expect(html).toContain('Ship #P1 later')
        expect(html).not.toContain('task-tag')
    })

    it('renders ==highlight== as <mark>', () => {
        expect(renderer().render('a ==highlighted== word').html).toContain('a <mark>highlighted</mark> word')
    })

    it('renders inline maths with KaTeX and reports it, leaving `$$` and `\\$` as text', () => {
        const r = renderer().render('cost $E = mc^2$ and \\$5 and $$ empty')
        expect(r.hasMath).toBe(true)
        expect(r.html).toContain('<span class="math math-inline"><span class="katex">')
        expect(r.html).toContain('$5')
        expect(r.html).toContain('$$ empty')
    })

    it('renders a math fence in display mode', () => {
        const r = renderer().render('```math\n\\sum_i x_i\n```\n')
        expect(r.hasMath).toBe(true)
        expect(r.html).toContain('<div class="math math-block"><span class="katex-display">')
    })

    it('uses the pre-rendered SVG for a Mermaid fence, and falls back to a pre block when there is none', () => {
        const withSvg = renderer({ mermaidSvg: (src) => (src.includes('A-->B') ? '<svg>diagram</svg>' : undefined) })
        const r = withSvg.render('```mermaid\ngraph TD; A-->B;\n```\n')
        expect(r.html).toContain('<figure class="diagram diagram-mermaid"><svg>diagram</svg></figure>')
        expect(r).toMatchObject({ hasMermaid: true, mermaidFallback: false })
        const without = renderer().render('```mermaid\ngraph TD; A-->B;\n```\n')
        expect(without.html).toContain('<pre class="mermaid">graph TD; A--&gt;B;\n</pre>')
        expect(without).toMatchObject({ hasMermaid: true, mermaidFallback: true })
    })

    it('uses pre-highlighted code when the host has it, else escaped code with the language class', () => {
        const r = renderer({ highlighted: (lang, code) => (lang === 'js' ? `<span class="tok-keyword">${code.trim()}</span>` : undefined) })
        expect(r.render('```js\nlet\n```\n').html).toContain('<pre><code class="language-js"><span class="tok-keyword">let</span></code></pre>')
        expect(r.render('```rust\nlet <x>\n```\n').html).toContain('<pre><code class="language-rust">let &lt;x&gt;\n</code></pre>')
    })

    it('rewrites asset references, applies the display-size hint as a cap, and lists the assets', () => {
        const r = renderer().render('![Chart|300x200](../assets/chart.a1b2c3d4.png)\n\n[Report](../assets/q3%20report.5e6f.pdf)\n')
        expect(r.html).toContain('<img src="assets/chart.a1b2c3d4.png" alt="Chart" style="max-width:300px;max-height:200px">')
        expect(r.html).toContain('<a href="assets/q3%20report.5e6f.pdf">Report</a>')
        expect(r.assets).toEqual(['chart.a1b2c3d4.png', 'q3 report.5e6f.pdf'])
    })

    it('leaves a web image and a file link alone', () => {
        const r = renderer().render('![x](https://example.com/x.png) [f](file:///home/me/a.txt)')
        expect(r.html).toContain('src="https://example.com/x.png"')
        expect(r.html).toContain('href="file:///home/me/a.txt"')
        expect(r.assets).toEqual([])
    })

    it('gives headings ids and collects a table of contents from h2 to h4', () => {
        const r = renderer().render('# Title\n\n## Getting Started\n\n### Install\n\n## Getting Started\n\n##### Deep\n')
        expect(r.toc).toEqual([
            { level: 2, id: 'getting-started', text: 'Getting Started' },
            { level: 3, id: 'install', text: 'Install' },
            { level: 2, id: 'getting-started-2', text: 'Getting Started' },
        ])
        expect(r.html).toContain('<h1 id="title">Title</h1>')
    })

    it('reads a --- the way the editor draws it: a rule on its own, a heading underline under text', () => {
        // Editor Content Rules → Standard prose: the parser decides in both places. A `- ---`
        // bullet is a rule in both, but here it is a full-width <hr> that ends the list, where the
        // editor keeps the bullet's dot.
        const { html } = renderer().render('a\n\n---\n\n- b\n- ---\n\nTitle\n---\n')
        expect(html.match(/<hr>/g)).toHaveLength(2)
        expect(html).toMatch(/<h2[^>]*>Title<\/h2>/)
    })

    it('ends a table at a --- under it and draws the rule, as the editor does', () => {
        const { html } = renderer().render('| a | b |\n| - | - |\n| 1 | 2 |\n---\n')
        expect(html).toMatch(/<\/table>\s*<hr>/)
        expect(html).not.toContain('<h2')
    })

    it('renders GFM tables, strikethrough and autolinks', () => {
        const r = renderer().render('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n~~gone~~ https://example.com\n')
        expect(r.html).toContain('<table>')
        expect(r.html).toContain('<s>gone</s>')
        expect(r.html).toContain('<a href="https://example.com">https://example.com</a>')
    })

    it('extracts plain text and an excerpt for search, skipping diagrams and maths', () => {
        const r = renderer().render('- Hello **world** [[Physics]]\n\n```mermaid\ngraph TD\n```\n\n```js\nlet x\n```\n')
        expect(r.text).toBe('Hello world Physics\nlet x')
        expect(r.excerpt).toBe('Hello world Physics let x')
    })

    it('lists the fences of a body for the pre-render pass', () => {
        expect(renderer().fences('```mermaid\nA\n```\n\n```js\nb\n```\n')).toEqual([
            { lang: 'mermaid', code: 'A\n' },
            { lang: 'js', code: 'b\n' },
        ])
    })

    it('renders one line inline, for a backlink context', () => {
        expect(renderer().renderInline('see [[Physics]] and *it*')).toBe('see <a href="physics.html" class="wikilink">Physics</a> and <em>it</em>')
    })
})

describe('excerptOf', () => {
    it('cuts on a word boundary with an ellipsis', () => {
        const long = 'word '.repeat(60)
        const e = excerptOf(long)
        expect(e.length).toBeLessThanOrEqual(201)
        expect(e.endsWith('…')).toBe(true)
        expect(e).not.toContain('  ')
    })
})
