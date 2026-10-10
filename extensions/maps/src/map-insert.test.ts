import { describe, expect, it } from 'vitest'

import { type MapInsertNeighbour, planMapInsert } from './map-insert'

// Where `/map` puts a new, empty Map Block (ADR 0118): where a code block would go, on an empty
// bullet's line beside its dot, with nothing added round it, and the caret outside it, where the
// map stays drawn and its search box can take the keyboard.

/** A fence, a table row or an image, a bullet's or not: what map-commands.ts reads from the editor's analysis. */
const BLOCK_LINE = /^\s*(?:-\s+(?:\[[ xX]\]\s+)?)?(?:```|\||!\[)/

function insert(lines: string[], caretLine: number, frontmatterLines = 0): { text: string; caret: number } {
    const text = lines.join('\n')
    const from = lines.slice(0, caretLine).reduce((sum, line) => sum + line.length + 1, 0)
    const line = { from, to: from + lines[caretLine].length, text: lines[caretLine] }
    const neighbour = (other: string | undefined): MapInsertNeighbour => (other === undefined ? 'none' : BLOCK_LINE.test(other) ? 'block' : 'plain')
    const before = caretLine === frontmatterLines ? 'none' : neighbour(lines[caretLine - 1])
    const plan = planMapInsert(line, { before, after: neighbour(lines[caretLine + 1]) })
    return { text: text.slice(0, plan.from) + plan.insert + text.slice(plan.to), caret: plan.caret }
}

describe('/map', () => {
    it("takes an empty prose line's place and adds nothing after it, the caret waiting on the line after", () => {
        const result = insert(['Intro', '', 'After'], 1)
        expect(result.text).toBe('Intro\n```map\n```\nAfter')
        expect(result.caret).toBe(result.text.indexOf('After'))
    })

    it("adds no line after a map on the document's last line: the caret waits at the end of the line before", () => {
        const result = insert(['Intro', ''], 1)
        expect(result.text).toBe('Intro\n```map\n```')
        expect(result.caret).toBe('Intro'.length)
    })

    it('goes beneath a line of prose, which keeps the caret', () => {
        const result = insert(['Places near [[Campsites]]', 'After'], 0)
        expect(result.text).toBe('Places near [[Campsites]]\n```map\n```\nAfter')
        expect(result.caret).toBe('Places near [[Campsites]]'.length)
    })

    it("goes beneath a bullet at its content column, as the bullet's own lines", () => {
        const result = insert(['- Shortlist', '  - Pebble Cove', 'After'], 1)
        expect(result.text).toBe('- Shortlist\n  - Pebble Cove\n    ```map\n    ```\nAfter')
    })

    it("adds no line after a map put beneath the document's last line", () => {
        expect(insert(['- Shortlist', '  - Pebble Cove'], 1).text).toBe('- Shortlist\n  - Pebble Cove\n    ```map\n    ```')
        expect(insert(['Places near [[Campsites]]'], 0).text).toBe('Places near [[Campsites]]\n```map\n```')
    })

    it("opens on an empty bullet's line, beside its dot, the caret waiting on the line after the map", () => {
        const result = insert(['- Garden', '- ', '- After'], 1)
        expect(result.text).toBe('- Garden\n- ```map\n  ```\n- After')
        expect(result.caret).toBe(result.text.indexOf('- After'))
    })

    it("opens on a nested empty bullet's line at its content column, ending the document with nothing after it", () => {
        const result = insert(['- Garden', '  - '], 1)
        expect(result.text).toBe('- Garden\n  - ```map\n    ```')
        expect(result.caret).toBe('- Garden'.length)
    })

    it('goes beneath an empty task rather than on its line, where a fence never opens', () => {
        expect(insert(['- [ ] ', 'After'], 0).text).toBe('- [ ] \n  ```map\n  ```\nAfter')
    })

    it("keeps an empty line's indentation", () => {
        expect(insert(['- Shortlist', '  ', 'After'], 1).text).toBe('- Shortlist\n  ```map\n  ```\nAfter')
    })

    it('adds no line between a new map and a block below it, the caret waiting on the plain line before', () => {
        for (const below of [['```map', '```'], ['```mermaid', 'graph TD', '```'], ['| Day | Place |', '| --- | --- |', '| 1 | Harbour |'], ['![Plan](plan.png)']]) {
            const result = insert(['Intro', '', ...below], 1)
            expect(result.text).toBe(['Intro', '```map', '```', ...below].join('\n'))
            expect(result.caret).toBe('Intro'.length)
        }
    })

    it('waits on the plain line after when a block ends on the line before', () => {
        const result = insert(['```mermaid', 'graph TD', '```', '', 'After'], 3)
        expect(result.text).toBe('```mermaid\ngraph TD\n```\n```map\n```\nAfter')
        expect(result.caret).toBe(result.text.indexOf('After'))
    })

    it("waits on a block's line when that is the only line beside the map", () => {
        const result = insert(['- ', '  ```map', '  ```'], 0)
        expect(result.text).toBe('- ```map\n  ```\n  ```map\n  ```')
        expect(result.caret).toBe('- ```map\n  ```\n'.length)
    })

    it('adds a line after a map that would be all the document holds, the one place left for the caret', () => {
        const alone = insert([''], 0)
        expect(alone.text).toBe('```map\n```\n')
        expect(alone.caret).toBe(alone.text.length)
        // The frontmatter's closing line is no place for the caret.
        const afterFrontmatter = insert(['---', 'title: Trips', '---', ''], 3, 3)
        expect(afterFrontmatter.text).toBe('---\ntitle: Trips\n---\n```map\n```\n')
        expect(afterFrontmatter.caret).toBe(afterFrontmatter.text.length)
    })

    it('adds no line between a map put beneath a line and a map below that line', () => {
        expect(insert(['Intro', '```map', '```'], 0).text).toBe('Intro\n```map\n```\n```map\n```')
        expect(insert(['- Shortlist', '  ```map', '  ```'], 0).text).toBe('- Shortlist\n  ```map\n  ```\n  ```map\n  ```')
    })
})
