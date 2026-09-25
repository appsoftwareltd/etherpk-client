/**
 * The Rich Paste converter in Node (Editor Content Rules → *Rich Paste*; the mapping table in the
 * plan `2026-09-22 Rich Paste.md`), over linkedom's `DOMParser` standing in for the browser's.
 */

import { DOMParser } from 'linkedom'
import { describe, expect, it } from 'vitest'

import { blocksAsMarkdown, blocksAsOutline, htmlToBlocks, nestSections } from './html-blocks'

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html') as unknown as Document
const convert = (html: string, displaySize?: string) => htmlToBlocks(parse(html), { displaySize })
const outline = (html: string) => blocksAsOutline(convert(html).blocks)
const markdown = (html: string) => blocksAsMarkdown(convert(html).blocks)

/** What Chrome puts on the clipboard around a web selection. */
const chrome = (fragment: string) => `<meta charset='utf-8'><html><head></head><body><!--StartFragment-->${fragment}<!--EndFragment--></body></html>`

describe('blocks: paragraphs, headings and sections', () => {
    it('a paragraph is a block; whitespace collapses as HTML reads it', () => {
        expect(outline('<p>Data   visualization\n empowers&nbsp;users to</p>')).toBe('- Data visualization empowers users to')
    })

    it('consecutive paragraphs are sibling blocks, and stray text is a paragraph too', () => {
        expect(outline('<p>one</p><p>two</p>three')).toBe('- one\n- two\n- three')
    })

    it('a heading owns its section in the outline, through to the next heading of its level or higher', () => {
        const html = '<h2>Setup</h2><p>a</p><h3>Sub</h3><p>b</p><h2>Use</h2><p>c</p>'
        expect(outline(html)).toBe('- ## Setup\n  - a\n  - ### Sub\n    - b\n- ## Use\n  - c')
        expect(markdown(html)).toBe('## Setup\n\na\n\n### Sub\n\nb\n\n## Use\n\nc')
    })

    it('nestSections leaves the input alone', () => {
        const blocks = convert('<h1>T</h1><p>p</p>').blocks
        nestSections(blocks)
        expect(blocks.map((b) => b.children.length)).toEqual([0, 0])
    })

    it('containers flow their content into the surrounding list; a container edge ends a paragraph', () => {
        expect(outline('<div><div>a</div>b<section>c</section></div>')).toBe('- a\n- b\n- c')
    })

    it('a <br> is a soft line inside the block; an <hr> is dropped', () => {
        expect(outline('<p>one<br>two</p><hr><p>three</p>')).toBe('- one\n  two\n- three')
    })

    it('Chrome’s wrapper, comments, head and the dropped elements contribute nothing', () => {
        expect(outline(chrome('<style>p{}</style><script>x()</script><nav>menu</nav><p>text<button>go</button></p><template>t</template>'))).toBe('- text')
        expect(outline('<p hidden>no</p><p style="display:none">no</p><p>yes</p>')).toBe('- yes')
    })
})

describe('blocks: inline marks and links', () => {
    it('bold, italic, code, strikethrough and highlight take their marks, whitespace kept outside them', () => {
        expect(outline('<p><b> bold </b>x <em>it</em> <code>c()</code> <s>gone</s> <mark>hi</mark></p>')).toBe('- **bold** x *it* `c()` ~~gone~~ ==hi==')
        expect(outline('<p><strong>a</strong><i>b</i><del>c</del><strike>d</strike><kbd>Ctrl</kbd></p>')).toBe('- **a***b*~~c~~~~d~~`Ctrl`')
    })

    it('Google Docs’ font-weight:normal bold is not bold', () => {
        expect(outline('<b style="font-weight:normal;" id="docs-internal-guid-1"><p>plain</p></b>')).toBe('- plain')
    })

    it('a link keeps its target for the schemes the editor opens; a fragment, javascript: or unresolvable relative target is its text', () => {
        expect(outline('<p><a href="https://x.test/a?b=1">A</a> <a href="mailto:me@x.test">M</a> <a href="#top">T</a> <a href="javascript:x()">J</a> <a href="/rel">R</a></p>')).toBe(
            '- [A](https://x.test/a?b=1) [M](mailto:me@x.test) T J R',
        )
    })

    it('a relative link or image resolves against a <base>', () => {
        expect(outline('<base href="https://x.test/docs/"><p><a href="../a">A</a></p><img src="pic.png" alt="P">')).toBe('- [A](https://x.test/a)\n- ![P](https://x.test/docs/pic.png)')
    })

    it('a ) in a target is percent-encoded so the reference syntax survives', () => {
        expect(outline('<p><a href="https://x.test/a_(b)">A</a></p>')).toBe('- [A](https://x.test/a_%28b%29)')
    })

    it('span, u, sub, sup and unknown elements are their content', () => {
        expect(outline('<p><span>a</span><u>b</u><sub>2</sub><sup>3</sup><my-x>d</my-x></p>')).toBe('- ab23d')
    })
})

describe('blocks: lists', () => {
    it('list items are items, nested lists nest, and an ordered list keeps its numbers as text', () => {
        const html = '<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul><ol start="3"><li>c</li><li>d</li></ol>'
        expect(outline(html)).toBe('- a\n  - a1\n  - a2\n- b\n- 3. c\n- 4. d')
        expect(markdown(html)).toBe('- a\n  - a1\n  - a2\n- b\n- 3. c\n- 4. d')
    })

    it('a list nests under the paragraph before it in the outline, as the paste rule reads a bullet after prose; flat markdown keeps them apart', () => {
        expect(outline('<p>Shopping</p><ul><li>eggs</li></ul><p>after</p><ul><li>x<ul><li>y</li></ul></li></ul>')).toBe('- Shopping\n  - eggs\n- after\n  - x\n    - y')
        expect(markdown('<p>Shopping</p><ul><li>eggs</li></ul>')).toBe('Shopping\n\n- eggs')
        // Inside a section, under the section's paragraph rather than its heading.
        expect(outline('<h1>T</h1><p>p</p><ul><li>x</li></ul>')).toBe('- # T\n  - p\n    - x')
    })

    it('an item with paragraphs inside keeps the first as its text and the rest as children', () => {
        expect(outline('<ul><li><p>a</p><p>more</p></li></ul>')).toBe('- a\n  - more')
    })

    it('an item that is only a nested list is an empty bullet over its children', () => {
        expect(outline('<ul><li><ul><li>deep</li></ul></li></ul>')).toBe('- \n  - deep')
    })

    it('a list inside a heading’s section nests under the section', () => {
        expect(outline('<h1>T</h1><ul><li>x</li></ul><p>after</p>')).toBe('- # T\n  - x\n  - after')
    })
})

describe('blocks: code, quotes and tables', () => {
    it('a <pre> is a fenced block with its whitespace kept and its language from the class', () => {
        expect(outline('<pre class="language-ts"><code>const x = 1\n  if (x) {\n    y()\n  }</code></pre>')).toBe('- ```ts\n  const x = 1\n    if (x) {\n      y()\n    }\n  ```')
        expect(outline('<pre>\nplain\n</pre>')).toBe('- ```\n  plain\n  ```')
        expect(markdown('<pre><code class="lang-js">a</code></pre>')).toBe('```js\na\n```')
    })

    it('a blockquote is one block of > lines, its paragraphs and lists inside', () => {
        expect(outline('<blockquote><p>one</p><p>two</p><ul><li>x</li></ul></blockquote>')).toBe('- > one\n  >\n  > two\n  >\n  > - x')
    })

    it('a table is one block of GFM rows, the first row the header, cells escaped', () => {
        const html = '<table><thead><tr><th>Name</th><th>Qty</th></tr></thead><tbody><tr><td>a|b</td><td>1</td></tr><tr><td>c</td></tr></tbody></table>'
        expect(outline(html)).toBe('- | Name | Qty |\n  | --- | --- |\n  | a\\|b | 1 |\n  | c |  |')
        expect(outline('<table><tr><td>x</td><td>y</td></tr><tr><td>1</td><td>2</td></tr></table>')).toBe('- | x | y |\n  | --- | --- |\n  | 1 | 2 |')
    })

    it('a spreadsheet selection (a table, cells with breaks and marks) is a table', () => {
        expect(outline('<table><tr><td><b>A</b></td><td>line<br>break</td></tr></table>')).toBe('- | **A** | line break |\n  | --- | --- |')
    })
})

describe('blocks: images', () => {
    it('an image inside a paragraph is a line of its own inside the block; alt from alt, else title', () => {
        expect(outline('<p>before <img src="https://x.test/p.png" alt="Pic"> after</p>')).toBe('- before\n  ![Pic](https://x.test/p.png)\n  after')
        expect(outline('<p><img src="https://x.test/p.png" title="Titled"></p>')).toBe('- ![Titled](https://x.test/p.png)')
    })

    it('a paragraph that is only images is a block per image, and a figure is the image with its caption under it', () => {
        expect(outline('<p><img src="https://x.test/1.png" alt="1"><img src="https://x.test/2.png" alt="2"></p>')).toBe('- ![1](https://x.test/1.png)\n- ![2](https://x.test/2.png)')
        expect(outline('<figure><img src="https://x.test/f.png" alt="F"><figcaption>Figure 1. <b>Expanding</b> the view.</figcaption></figure>')).toBe(
            '- ![F](https://x.test/f.png)\n  Figure 1. **Expanding** the view.',
        )
    })

    it('every image written is reported with the source string the text carries', () => {
        const { images } = convert('<p><img src="https://x.test/a.png" alt="A"><img src="data:image/png;base64,AAAA" alt="D"></p>', '300')
        expect(images).toEqual([
            { src: 'https://x.test/a.png', alt: 'A' },
            { src: 'data:image/png;base64,AAAA', alt: 'D' },
        ])
        expect(outline('<img src="https://x.test/a.png" alt="A">'.replace('>', '>'))).toContain('![A](https://x.test/a.png)')
    })

    it('carries the graph’s display-size hint on every image', () => {
        expect(blocksAsOutline(convert('<img src="https://x.test/a.png" alt="A">', '300').blocks)).toBe('- ![A|300](https://x.test/a.png)')
    })

    it('a declared-tiny image, a scheme the browser never reads, a non-image data url and an unresolvable relative source are dropped, alt kept as text', () => {
        expect(outline('<p>x <img src="https://x.test/i.png" width="16" height="16" alt="icon"> y</p>')).toBe('- x icon y')
        expect(outline('<p><img src="https://x.test/i.png" style="height: 20px" alt="i"></p>')).toBe('- i')
        expect(outline('<p><img src="file:///C:/Temp/clip.png" alt="W"></p>')).toBe('- W')
        expect(outline('<p><img src="data:text/plain;base64,QQ==" alt="T"></p>')).toBe('- T')
        expect(outline('<p><img src="rel/pic.png" alt="R"></p>')).toBe('- R')
        expect(outline('<p><img src="https://x.test/i.png"></p>')).toBe('- ![](https://x.test/i.png)')
    })

    it('a srcset picks the largest candidate, width descriptors outranking density', () => {
        expect(outline('<img src="https://x.test/s.png" srcset="https://x.test/a.png 400w, https://x.test/b.png 1600w, https://x.test/c.png 800w" alt="S">')).toBe('- ![S](https://x.test/b.png)')
        expect(outline('<img src="https://x.test/s.png" srcset="https://x.test/1x.png 1x, https://x.test/2x.png 2x" alt="S">')).toBe('- ![S](https://x.test/2x.png)')
    })

    it('alt text is one line without brackets or a pipe, which would read as a size hint', () => {
        expect(outline('<img src="https://x.test/a.png" alt="a [b] | c\nd">')).toBe('- ![a b c d](https://x.test/a.png)')
    })

    it('an image inside a link is the image; the link is not written around nothing', () => {
        expect(outline('<a href="https://x.test/"><img src="https://x.test/a.png" alt="A"></a>')).toBe('- ![A](https://x.test/a.png)')
    })
})

describe('blocks: the shapes found in review', () => {
    it('a <pre> holding a backtick run gets a fence longer than the run, so the code cannot close it', () => {
        expect(outline('<pre>```</pre><p>after</p>')).toBe('- ````\n  ```\n  ````\n- after')
        expect(outline('<pre>a `b` c</pre>')).toBe('- ```\n  a `b` c\n  ```')
    })

    it('a link around block content (a card) links each block’s first line and leaves an image alone', () => {
        expect(outline('<a href="https://x.test/post"><h3>Title</h3><p>Summary</p><img src="https://x.test/c.png" alt="C"></a>')).toBe(
            '- ### [Title](https://x.test/post)\n  - [Summary](https://x.test/post)\n  - ![C](https://x.test/c.png)',
        )
    })

    it('an image in a table cell or a caption is its alt text and is recorded nowhere; a nested list in a cell keeps every line', () => {
        const { blocks, images } = convert('<table><tr><td><img src="https://x.test/cell.png" alt="C"></td><td><ul><li>a<ul><li>deep</li></ul></li></ul></td></tr></table>')
        expect(blocksAsOutline(blocks)).toBe('- | C | a deep |\n  | --- | --- |')
        expect(images).toEqual([])
    })

    it('an image inside a heading goes after the heading line; a heading that is only an image is the image', () => {
        expect(outline('<h2><img src="https://x.test/i.png" alt="I"> Title</h2><p>p</p>')).toBe('- ## Title\n  ![I](https://x.test/i.png)\n  - p')
        expect(outline('<h2><img src="https://x.test/i.png" alt="I"></h2>')).toBe('- ![I](https://x.test/i.png)')
    })
})

describe('the report of 2026-09-22: an article section with a figure', () => {
    it('reads as an outline of the page', () => {
        const html = chrome(
            '<h2>Embedding</h2><p>You add the prompt like this one: <em>“Data visualization empowers users to”</em>.</p>' +
                '<figure><img src="https://x.test/embedding.png" alt="Embedding layer"><figcaption>Figure 1. Expanding the Embedding layer view.</figcaption></figure>' +
                '<h3>Step 1: Tokenization</h3><p>Tokenization is the process of breaking down the input text.</p>',
        )
        expect(outline(html)).toBe(
            [
                '- ## Embedding',
                '  - You add the prompt like this one: *“Data visualization empowers users to”*.',
                '  - ![Embedding layer](https://x.test/embedding.png)',
                '    Figure 1. Expanding the Embedding layer view.',
                '  - ### Step 1: Tokenization',
                '    - Tokenization is the process of breaking down the input text.',
            ].join('\n'),
        )
    })
})
