import { describe, expect, it } from 'vitest'

import { renderForPrint, type PrintEnvironment } from './render-for-print'

const PNG = new Uint8Array([1, 2, 3])
const print = async (text: string, environment: PrintEnvironment = {}) => renderForPrint({ name: 'Garden', text }, environment)

describe('a document as it prints', () => {
    it('starts with its name and leaves out its frontmatter', async () => {
        const { html } = await print('---\ntitle: Garden\npublic: true\n---\n- water the beans\n')
        expect(html).toMatch(/^<h1>Garden<\/h1>/)
        expect(html).toContain('water the beans')
        expect(html).not.toContain('public')
    })

    it('escapes the name', async () => {
        expect((await renderForPrint({ name: 'A <b> & "c"', text: '' }, {})).html).toContain('<h1>A &lt;b&gt; &amp; &quot;c&quot;</h1>')
    })

    it('prints every block, and a wikilink as its words', async () => {
        const { html } = await print('- beds\n  - see [[Kitchen]] and [[[[Garden]] Notes]]\n    - deep\n')
        expect(html).toContain('see Kitchen and Garden Notes')
        expect(html).toContain('deep')
        expect(html).not.toContain('<a')
        expect(html).not.toContain('[[')
    })

    it('keeps a web link as a link', async () => {
        expect((await print('[seeds](https://example.com/seeds)')).html).toContain('<a href="https://example.com/seeds">seeds</a>')
    })

    it('prints raw HTML as the text it is in the editor', async () => {
        const { html } = await print('<img src=x onerror=alert(1)> and <b>bold</b>\n\n<div>block</div>\n')
        expect(html).not.toMatch(/<img|<b>|<div>/)
        expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    })

    it('leaves each picture\'s reference as it was written, with its alt and size', async () => {
        const { html } = await print('![pond|300](../assets/pond.a1b2c3d4.png)')
        expect(html).toContain('src="../assets/pond.a1b2c3d4.png"')
        expect(html).toContain('alt="pond"')
        expect(html).toContain('max-width:')
    })

    it('draws a drawing, a map and a diagram, and hands over their pictures', async () => {
        const { html, pictures } = await print('```excalidraw.drawing\n{}\n```\n\n```map\npoint 1,2 Shed\n```\n\n```mermaid\ngraph TD\n```\n', {
            publishFence: ({ info }) => (info === 'excalidraw.drawing' ? Promise.resolve({ kind: 'picture', type: 'image/png', bytes: PNG, width: 40, height: 30, alt: 'a shed' }) : undefined),
            renderMap: async () => ({ bytes: PNG, type: 'image/png', width: 100, height: 80 }),
            renderMermaid: async () => '<svg id="mermaid-1"><g></g></svg>',
        })
        const drawn = [...pictures.keys()]
        expect(drawn.length).toBeGreaterThan(0)
        for (const path of drawn) expect(html).toContain(`src="${path}"`)
        expect(html).toContain('alt="a shed"')
        expect(html).toContain('<svg id="mermaid_print_1"')
    })

    it('says what it left out, where it was', async () => {
        const { html, pictures } = await print('before\n\n```excalidraw.drawing\n{"secret":1}\n```\n\n```map\npoint 1,2 Shed\n```\n\n![clip](../assets/pond.a1b2c3d4.mp4)\n\nafter')
        expect(html).toContain('Content from the excalidraw extension not printed. Open &quot;Garden&quot; in EtherPK to see the content.')
        expect(html).toContain('Map not printed. Open &quot;Garden&quot; in EtherPK to see the map.')
        expect(html).toContain('Video not printed. Open &quot;Garden&quot; in EtherPK to watch &quot;clip&quot;.')
        expect(html).not.toContain('secret')
        expect(html).not.toContain('1,2')
        expect(html).not.toContain('<video')
        // Within its line, where a paragraph would split the one around it.
        expect(html).not.toContain('<p><p')
        expect(pictures.size).toBe(0)
        expect(html.indexOf('before')).toBeLessThan(html.indexOf('Map not printed'))
        expect(html.indexOf('Video not printed')).toBeLessThan(html.indexOf('after'))
    })

    it('prints a task with its box and its tags, code as it is, and a table', async () => {
        const { html } = await print('- [x] #P1 water the beans\n\n```js\nconst a = 1 < 2\n```\n\n| bed | width |\n| --- | --- |\n| one | 2 |\n')
        expect(html).toContain('type="checkbox"')
        expect(html).toContain('Priority 1')
        expect(html).toContain('const a = 1 &lt; 2')
        expect(html).toContain('<table>')
    })
})
