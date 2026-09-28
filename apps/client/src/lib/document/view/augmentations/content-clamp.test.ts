import { describe, expect, it } from 'vitest'

import { analysisFor } from '../analysis/editor-analysis'
import { editorFixture } from '../testing/editor-state-fixture'
import { blockWidgetIndent, codeLineIndent, CONTENT_GUTTER, indentedLineReading, INDENT_STEP_PX, proseTextInset } from './content-clamp'
import { CHECKBOX_SLOT } from './task-checkbox'

/**
 * Where a code body line's source column 0 lands: the block's code column (Editor Content Rules →
 * Fenced Code Blocks → Presentation). Spaces past it are the code's own indentation, drawn as
 * monospace columns after it, as a `<pre>` draws them. The browser rows are in
 * `tests-client/fenced-code-scroll.test.ts`.
 */
describe('codeLineIndent (CommonMark)', () => {
    it("starts an unindented line of a prose block the panel's padding in from its edge", () => {
        expect(codeLineIndent(0, 0)).toEqual({ padding: '0.7em', inner: '0.7em' })
    })

    it("starts an indented line of a prose block at the same code column, its spaces after it", () => {
        expect(codeLineIndent(4, 0)).toEqual({ padding: 'calc(0.7em + 4ch)', inner: '0.7em' })
    })

    it("starts a line of an indented fence (a bullet's) at the fence column, its own spaces reaching it", () => {
        expect(codeLineIndent(2, 2)).toEqual({ padding: '2ch', inner: '0px' })
        expect(codeLineIndent(6, 2)).toEqual({ padding: '6ch', inner: '0px' })
    })

    it('brings a line indented less than its fence out to the fence column', () => {
        expect(codeLineIndent(0, 2)).toEqual({ padding: '2ch', inner: '2ch' })
        expect(codeLineIndent(1, 3)).toEqual({ padding: '3ch', inner: '2ch' })
    })
})

/**
 * Whether an indented non-bullet line is drawn as its bullet's continuation or as plain prose
 * (Editor Content Rules → Standard prose). The pixel rows are in `tests-client/content-clamp-visual.test.ts`.
 */
describe('indentedLineReading', () => {
    const reading = (doc: string, line: number) => {
        const { lines, outline } = analysisFor(editorFixture(`${doc}|`).state)
        return indentedLineReading(lines, outline, line)
    }

    it('reads a line at its bullet’s content column as the bullet’s continuation (Logseq)', () => {
        expect(reading('- a\n  cont', 1)).toBe('continuation')
    })

    it('…and a line nested under that continuation, or under a `*` item, which the walk still gives to the bullet', () => {
        expect(reading('- a\n  cont\n    deeper', 2)).toBe('continuation')
        expect(reading('- a\n  * one\n    * two', 2)).toBe('continuation')
        expect(reading('- a\n  ```\n  code\n  ```\n    after', 4)).toBe('continuation')
    })

    it('…and a paragraph after a blank line in a list, which the walk leaves unowned but sits past the column', () => {
        expect(reading('- a\n  - b\n\n    x', 3)).toBe('continuation')
    })

    it('reads prose with no bullet above it as plain, whatever its indent (Obsidian)', () => {
        expect(reading(' text', 0)).toBe('plain')
        expect(reading('para\n    indented', 1)).toBe('plain')
    })

    it('…and a line short of the bullet’s content column: one space under a list is not yet a continuation', () => {
        expect(reading('- a\n x', 1)).toBe('plain')
        expect(reading('- a\n  - b\n   x', 2)).toBe('plain') // short of b's column, past a's: the keys read it as prose too
    })

    it('…whether or not it has text yet: a blank line one space in, which the walk owns, reads as its text will', () => {
        expect(reading('- a\n ', 1)).toBe('plain')
        expect(reading('- a\n  - b\n   ', 2)).toBe('plain')
        expect(reading('- a\n   ', 1)).toBe('continuation')
    })
})

/**
 * Where a block widget standing in for a line (an image, a table, a rendered fence) starts: where the
 * line's text would, as the clamp draws it, in the widths the clamp publishes on the editor. The
 * pixel rows are in `tests-client/content-clamp-visual.test.ts`.
 */
describe('blockWidgetIndent and proseTextInset', () => {
    const SPACE = 'var(--gk-prose-space, 1ch)'
    const DASH = 'var(--gk-prose-dash, 1ch)'
    const at = (doc: string, line: number) => {
        const { state } = editorFixture(`${doc}|`)
        const pos = state.doc.line(line + 1).from
        return { widget: blockWidgetIndent(state, pos), inset: proseTextInset(state, pos) }
    }

    it('puts nothing before a line at column 0', () => {
        expect(at('![x](y)', 0)).toEqual({ widget: null, inset: null })
    })

    it('starts plain prose its spaces’ measured width in, with no gutter and no nesting step (Obsidian)', () => {
        expect(at('para\n\n  ![x](y)', 2)).toEqual({ widget: `calc(2 * ${SPACE})`, inset: `calc(2 * ${SPACE})` })
        expect(at('para\n\n ![x](y)', 2).widget).toBe(`calc(${SPACE})`)
    })

    it('starts a continuation at its bullet’s text: the marker’s width and the gutter, after the bullet’s nesting step', () => {
        const text = `${DASH} + ${SPACE} + ${CONTENT_GUTTER}`
        expect(at('- a\n  ![x](y)', 1)).toEqual({ widget: `calc(${text})`, inset: `calc(${text})` })
        const nested = `2 * ${SPACE} + ${text}`
        expect(at('- a\n  - b\n    ![x](y)', 2)).toEqual({ widget: `calc(${INDENT_STEP_PX}px + ${nested})`, inset: `calc(${nested})` })
    })

    it('reads a line as the clamp and the keys do: the outline reaches it across a soft line, and one space short is prose', () => {
        expect(at('- a\n  cont\n    ![x](y)', 2).widget).toBe(`calc(2 * ${SPACE} + ${DASH} + ${SPACE} + ${CONTENT_GUTTER})`)
        expect(at('- a\n ![x](y)', 1).widget).toBe(`calc(${SPACE})`)
    })

    it('starts at a bullet’s text on a bullet line, where a form-1 fence’s live preview hangs under its collapsed render', () => {
        expect(at('- ```mermaid', 0).widget).toBe(`calc(${DASH} + ${SPACE} + ${CONTENT_GUTTER})`)
        expect(at('- a\n  - ```mermaid', 1).widget).toBe(`calc(${INDENT_STEP_PX}px + 2 * ${SPACE} + ${DASH} + ${SPACE} + ${CONTENT_GUTTER})`)
        expect(at('- [ ] ```mermaid', 0).widget).toBe(`calc(${DASH} + ${SPACE} + ${CONTENT_GUTTER} + ${CHECKBOX_SLOT} + ${SPACE})`)
    })
})
