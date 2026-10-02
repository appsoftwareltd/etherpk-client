/**
 * Missing blank lines after a list (ADR 0109): a line the editor and the publisher read as its own,
 * which CommonMark, and so every other markdown app, reads as a lazy continuation of the bullet above.
 * The fix must leave every line as the editor's outline reads it, and every heading, rule, link and
 * code block as the publisher reads it.
 */

import { parser as plainMarkdown } from '@lezer/markdown'
import fc from 'fast-check'
import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'

import { markdownParser } from '../inline-parts'
import { branchRange, continuationColumn, isBulletLine, ownerBulletIndex } from '../outliner'
import { listItemEndRule } from '../publish/markdown/list-item-end-rule'
import { createDocumentRenderer } from '../publish/markdown/render'
import { wikilinkOccurrencesInSource } from '../wikilink'
import { blankLineAfterList } from './blank-line-after-list'
import { checkedText } from './finding'
import { lineSplices, splitLines } from './line-diff'

const find = (text: string) => blankLineAfterList.find(checkedText(text))

const publisher = createDocumentRenderer({ resolve: () => ({ href: '404.html', missing: true }), assetHref: () => null })

const ONE = 'a line other apps read as part of the bullet above it'

describe('missing blank lines after a list', () => {
    it.each([
        ['a margin line under a bullet', '- a\nb\n', '- a\n\nb\n', [1]],
        ['a margin line under a soft line of the bullet', '- a\n  more\nb', '- a\n  more\n\nb', [2]],
        ['a margin line under a task', '- [ ] task\nnote', '- [ ] task\n\nnote', [1]],
        ['only the first of a run of margin lines', '- a\nb\nc', '- a\n\nb\nc', [1]],
        // Indented like the line, so the editor's outline reads it as it reads the line.
        ['a line one space short of the bullet text', '- a\n b', '- a\n \n b', [1]],
    ])('puts a blank line before %s', (_name, text, fixed, lines) => {
        expect(find(text)).toEqual({ lines, fixed, reason: ONE })
    })

    it("puts an indented blank line before a paragraph after a bullet's children, which the editor keeps in the bullet", () => {
        const text = '- a\n  - b\n  c\nd'
        const finding = find(text)
        expect(finding).toEqual({ lines: [2, 3], fixed: '- a\n  - b\n  \n  c\n\nd', reason: '2 lines other apps read as part of the bullets above them' })
        // The editor reads each line as it did: `c` in the block of `a`, `d` in no block.
        const was = text.split('\n')
        const now = finding!.fixed!.split('\n')
        expect([ownerBulletIndex(was, 2), ownerBulletIndex(was, 3)]).toEqual([0, null])
        expect([ownerBulletIndex(now, 3), ownerBulletIndex(now, 5)]).toEqual([0, null])
    })

    it.each([
        ['a rule', '- a\nb\n---', '- a\n\nb\n\n---', [1, 2]],
        ['a rule under a run of lines', '- a\nb\nc\n---', '- a\n\nb\nc\n\n---', [1, 3]],
        ['a rule between two lists', '- [ ] t\nnote\n---\n- next', '- [ ] t\n\nnote\n\n---\n- next', [1, 2]],
        ['a rule in the block of a parent', '- a\n  - b\n  c\n  ---', '- a\n  - b\n  \n  c\n  \n  ---', [2, 3]],
        ['a rule indented to the bullet text', '- a\nb\n  ---', '- a\n\nb\n  \n  ---', [1, 2]],
        ['an empty bullet, which stays one', '- a\nb\n- \n  - c', '- a\n\nb\n\n- \n  - c', [1, 2]],
    ])('keeps %s under the line from becoming its heading underline, with a blank line before it too', (_name, text, fixed, lines) => {
        expect(find(text)).toEqual({ lines, fixed, reason: ONE })
    })

    it("keeps a line whose own blank line changes nothing, where another line's would", () => {
        // The blank line before `b` would end the bullet before the unclosed fence below, so the editor
        // would read `x [[L]]` as code. The one before `  d` changes nothing on its own.
        const finding = find('- a\nb\n  - c\n  d\n  ```\nx [[L]]')
        expect(finding?.lines).toEqual([3])
        expect(finding?.fixed).toBe('- a\nb\n  - c\n  \n  d\n  ```\nx [[L]]')
    })

    it('keeps the line endings the page uses', () => {
        expect(find('- a\r\nb\r\n')?.fixed).toBe('- a\r\n\r\nb\r\n')
    })

    it('counts lines from the top of the page, the frontmatter included', () => {
        expect(find('---\ntitle: A\n---\n- a\nb')).toMatchObject({ lines: [4], fixed: '---\ntitle: A\n---\n- a\n\nb' })
    })

    it('changes nothing a published page shows for a margin line', () => {
        const text = '- a\nb\n- c\n  - d\ne\n- f\ng\n---\n'
        expect(publisher.render(find(text)!.fixed!).html).toBe(publisher.render(text).html)
    })

    it("spaces a list's items apart on a published page once a paragraph after children has its blank line, as CommonMark reads it", () => {
        const html = (text: string) => publisher.render(text).html.replace(/\n/g, '')
        const text = '- a\n  - b\n  c\n- d\n'
        expect(html(text)).toBe('<ul><li>a<ul><li>b</li></ul>c</li><li>d</li></ul>')
        expect(html(find(text)!.fixed!)).toBe('<ul><li><p>a</p><ul><li>b</li></ul><p>c</p></li><li><p>d</p></li></ul>')
    })

    it.each([
        ['a blank line already there', '- a\n\nb'],
        ['a soft line of the bullet', '- a\n  b'],
        ['a soft line under a bullet typed with two spaces after the dash', '-  a\n  b'],
        ['a bullet', '- a\n- b'],
        ['a heading', '- a\n# B'],
        ['a rule', '- a\n---'],
        ['a quote', '- a\n> b'],
        ['a code block', '- a\n```\nb\n```'],
        ['an empty bullet', '- \nb'],
        ['a numbered item, which the editor reads as text', '1. a\nb'],
        ['a * item, which the bullet check fixes first', '* a\nb'],
        ['a list in a quote, which the editor reads no outline in', '> - a\n> b'],
        ['a bullet indented with no-break spaces', '- a\n\u{a0}\u{a0}- b'],
        ['a line indented with no-break spaces', '- a\n\u{a0}b'],
        // A blank line would make it a link definition, which hides it on a published page, an HTML
        // block, which takes the bullet after it, or indented code.
        ['a line shaped like a link definition', '- a\n[x]: /url'],
        ['a lone tag', '- a\n<img src="x">\n- b [[L]]'],
        ['a line four columns past the margin under a bullet three in', '   - a\n    p'],
        // A blank line before the lone `-` under it would make that a list item, taking the code below.
        ['a line with a lone dash under it', '- a\nb\n-\n      p [[L]]'],
        // A `===` under it is the paragraph's text: a blank line before it would split the code spans
        // and links that run across it.
        ['a line with a row of equals signs under it', '- a\nb\n==='],
        ['a code span across a row of equals signs', '- a\nb `c\n===\nd` [[L]] `e`'],
        ['a link across a row of equals signs', '- a\nsee [the\n===\ndocs](https://example.com)'],
        // The blank line would end the code span that runs into the line, and the index would lose the link.
        ['a code span from the bullet into the line', '- run `npm\ninstall` then [[Setup]] `x`'],
        // After the blank line the editor would stop reading the link's lines as code, and the index would count it.
        ['a page where the editor would stop reading code', '   - a\n[y]:\n| a | b |\n|-|-|\n    ```\n      ```\n      [[L]]\n-->'],
        ['a line in the frontmatter', '---\ntags:\n- a\nb: c\n---\n'],
        ['a line in a code block', '```\n- a\nb\n```'],
        ['a page with no list', 'a\nb'],
    ])('finds nothing after %s', (_name, text) => {
        expect(find(text)).toBeNull()
    })
})

/** Pages built line by line from bullets at three depths, lines at and short of their columns, underlines and code. */
const listText = fc
    .array(
        fc.constantFrom(
            '- a',
            '- [ ] t',
            '-  a',
            '  - b',
            '    - c',
            'p',
            ' p',
            '  p',
            '   p',
            '    p',
            '\tp',
            '\u{a0}p',
            '* s',
            '1. n',
            '> q',
            '# H',
            '---',
            '  ---',
            '===',
            '[x]: /u',
            '-',
            '- ',
            '- - a',
            '- > q',
            '   - a',
            '<img src="x">',
            '</span>',
            'p [[L]]',
            '- b [[L]]',
            '      p [[L]]',
            'b `c',
            'd` [[L]] `e`',
            'see [the',
            'docs](https://e.x)',
            '- run `npm',
            '| a |',
            '|-|',
            '```',
            '  ```',
            'x *y',
            'z* w',
            '',
            '  ',
        ),
        { maxLength: 14 },
    )
    .map((lines) => lines.join('\n'))

/** The original lines' places in the fixed text, given the lines an inserted line goes before. */
function placesAfterFix(count: number, insertedBefore: readonly number[]): number[] {
    const before = new Set(insertedBefore)
    const places: number[] = []
    let shift = 0
    for (let i = 0; i < count; i++) {
        if (before.has(i)) shift++
        places.push(i + shift)
    }
    return places
}

/** Page lines in a heading, and page lines that are a rule, as one parser reads a page. */
interface Readings {
    heading: Set<number>
    rule: Set<number>
}

/** The editor's parser: lines in an ATX or setext heading, and rules. */
function editorReadings(text: string): Readings {
    const starts = [0]
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1)
    const lineAt = (offset: number) => {
        let line = 0
        while (line + 1 < starts.length && starts[line + 1] <= offset) line++
        return line
    }
    const readings: Readings = { heading: new Set(), rule: new Set() }
    markdownParser.parse(text).iterate({
        enter(node) {
            if (/Heading\d$/.test(node.name)) for (let line = lineAt(node.from); line <= lineAt(node.to); line++) readings.heading.add(line)
            if (node.name === 'HorizontalRule') readings.rule.add(lineAt(node.from))
        },
    })
    return readings
}

/** The lines inside a code, HTML or comment block, as the index's parser reads them: the lines its links skip. */
function blockCodeLines(text: string): Set<number> {
    const lines = new Set<number>()
    const lineAt = (offset: number) => text.slice(0, offset).split('\n').length - 1
    plainMarkdown.parse(text).iterate({
        enter(node) {
            if (!['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock'].includes(node.name)) return undefined
            for (let line = lineAt(node.from); line <= lineAt(node.to); line++) lines.add(line)
            return false
        },
    })
    return lines
}

/** The publisher's parser, the list rule included: lines in a heading, and rules. */
const site = new MarkdownIt({ html: true })
listItemEndRule(site)

function siteReadings(text: string): Readings {
    const readings: Readings = { heading: new Set(), rule: new Set() }
    for (const token of site.parse(text, {})) {
        if (!token.map) continue
        if (token.type === 'heading_open') for (let line = token.map[0]; line < token.map[1]; line++) readings.heading.add(line)
        if (token.type === 'hr') readings.rule.add(token.map[0])
    }
    return readings
}

describe('the fix', () => {
    it('inserts only blank lines, one before each line it flags, writes as splices, and leaves nothing more to flag', () => {
        fc.assert(
            fc.property(listText, (text) => {
                const finding = find(text)
                if (!finding?.fixed) return
                const was = splitLines(text)
                const now = splitLines(finding.fixed)
                const inserted = new Set(finding.lines.map((line, k) => line + k))
                expect(now.filter((_, i) => !inserted.has(i))).toEqual(was)
                for (const i of inserted) expect(now[i].text.trim(), JSON.stringify(text)).toBe('')
                let applied = text
                for (const splice of [...lineSplices(text, finding.fixed)].reverse()) applied = applied.slice(0, splice.from) + splice.insert + applied.slice(splice.to)
                expect(applied).toBe(finding.fixed)
                expect(find(finding.fixed), JSON.stringify(text)).toBeNull()
            }),
            { numRuns: 400 },
        )
    })

    it("leaves every line as the editor's outline reads it, every heading and rule as the publisher reads it, and the editor's parser agreeing with the publisher wherever it did", () => {
        fc.assert(
            fc.property(listText, (text) => {
                const finding = find(text)
                if (!finding?.fixed || checkedText(text).frontmatter > 0) return
                const was = text.split('\n')
                const now = finding.fixed.split('\n')
                const place = placesAfterFix(was.length, finding.lines)
                const moved = (line: number | null) => (line === null ? null : place[line])
                const at = (line: number) => `line ${line} of ${JSON.stringify(text)}`
                for (let i = 0; i < was.length; i++) {
                    const j = place[i]
                    expect(now[j], at(i)).toBe(was[i])
                    expect(continuationColumn(now, j), `continuation, ${at(i)}`).toBe(continuationColumn(was, i))
                    expect(ownerBulletIndex(now, j), `owner, ${at(i)}`).toBe(moved(ownerBulletIndex(was, i)))
                    if (isBulletLine(was[i])) expect(branchRange(now, j).end, `branch, ${at(i)}`).toBe(place[branchRange(was, i).end])
                }
                // The editor and the index read the same links, and the same lines as code.
                const links = (source: string, line: (at: number) => number) =>
                    wikilinkOccurrencesInSource(source)
                        .map((link) => `${line(link.line)}:${link.matchStart}:${link.concept}`)
                        .sort()
                const unmoved = (line: number) => line
                expect(links(finding.fixed, unmoved), `links in ${JSON.stringify(text)}`).toEqual(links(text, (line) => place[line]))
                const codeWas = blockCodeLines(text)
                const codeNow = blockCodeLines(finding.fixed)
                for (let i = 0; i < was.length; i++) expect(codeNow.has(place[i]), `code, ${at(i)}`).toBe(codeWas.has(i))
                const before = { site: siteReadings(text), editor: editorReadings(text) }
                const after = { site: siteReadings(finding.fixed), editor: editorReadings(finding.fixed) }
                for (let i = 0; i < was.length; i++) {
                    for (const kind of ['heading', 'rule'] as const) {
                        const siteWas = before.site[kind].has(i)
                        const siteNow = after.site[kind].has(place[i])
                        expect(siteNow, `the site's ${kind}, ${at(i)}`).toBe(siteWas)
                        if (before.editor[kind].has(i) === siteWas) expect(after.editor[kind].has(place[i]), `the editor's ${kind}, ${at(i)}`).toBe(siteNow)
                    }
                }
            }),
            { numRuns: 400 },
        )
    })
})
