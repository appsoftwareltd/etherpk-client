import { EditorState } from '@codemirror/state'
import { afterEach, describe, expect, it } from 'vitest'

import { type ProtectionStatus, setActiveProtectionStatus } from '../protection/active-protection'
import { editorAnalysis } from './analysis/editor-analysis'
import { isProtectedDocumentFacet } from './augmentations/protected-document'
import { type BlockInsertNeighbour, blockInsertable, blockInsertPlan, planBlockInsert } from './block-insert'

// Where `context.editor.insertBlock` puts a block: where a code block, a table or a map goes, on an
// empty bullet's line beside its dot, and a fence with the caret outside it.

/** A fence, a table row or an image, a bullet's or not: what the editor's analysis reads as a block's line. */
const BLOCK_LINE = /^\s*(?:-\s+(?:\[[ xX]\]\s+)?)?(?:```|\||!\[)/

function insert(lines: string[], caretLine: number, block: string[]): { text: string; caret: number; blockStart: number } {
    const text = lines.join('\n')
    const from = lines.slice(0, caretLine).reduce((sum, line) => sum + line.length + 1, 0)
    const line = { from, to: from + lines[caretLine].length, text: lines[caretLine] }
    const neighbour = (other: string | undefined): BlockInsertNeighbour => (other === undefined ? 'none' : BLOCK_LINE.test(other) ? 'block' : 'plain')
    const plan = planBlockInsert(line, { before: caretLine === 0 ? 'none' : neighbour(lines[caretLine - 1]), after: neighbour(lines[caretLine + 1]) }, block)
    return { text: text.slice(0, plan.from) + plan.insert + text.slice(plan.to), caret: plan.caret, blockStart: plan.blockStart }
}

const video = ['```video', 'https://youtu.be/abcdefghijk', '```']

describe('insertBlock', () => {
    it("takes an empty prose line's place, the caret waiting on the line after the fence", () => {
        const result = insert(['Intro', '', 'After'], 1, video)
        expect(result.text).toBe('Intro\n```video\nhttps://youtu.be/abcdefghijk\n```\nAfter')
        expect(result.caret).toBe(result.text.indexOf('After'))
        expect(result.blockStart).toBe('Intro\n'.length)
    })

    it('adds an empty line after a fence that would otherwise have no line beside it', () => {
        const result = insert([''], 0, video)
        expect(result.text).toBe('```video\nhttps://youtu.be/abcdefghijk\n```\n')
        expect(result.caret).toBe(result.text.length)
    })

    it("opens a fence on an empty bullet's line, its other lines at the bullet's content column", () => {
        const result = insert(['- Garden', '- ', '- After'], 1, video)
        expect(result.text).toBe('- Garden\n- ```video\n  https://youtu.be/abcdefghijk\n  ```\n- After')
        expect(result.blockStart).toBe('- Garden\n'.length)
    })

    it("never opens a fence on an empty task's line, which goes beneath it as the bullet's own", () => {
        const result = insert(['- [ ] '], 0, video)
        expect(result.text).toBe('- [ ] \n  ```video\n  https://youtu.be/abcdefghijk\n  ```')
    })

    it('goes beneath a line with text, at its content column, the caret staying on the line', () => {
        const result = insert(['- Kitchen ideas', '- After'], 0, video)
        expect(result.text).toBe('- Kitchen ideas\n  ```video\n  https://youtu.be/abcdefghijk\n  ```\n- After')
        expect(result.caret).toBe('- Kitchen ideas'.length)
        expect(result.blockStart).toBe('- Kitchen ideas\n'.length)
    })

    it('gives a blank line inside the block the indentation of the line after it, so the block stays one branch', () => {
        const result = insert(['- Garden', '  - Kitchen', '  - Shed'], 1, ['- Agent Chat', '  - 1. Dig', '', '    Then rake.'])
        expect(result.text).toBe('- Garden\n  - Kitchen\n    - Agent Chat\n      - 1. Dig\n        \n        Then rake.\n  - Shed')
    })

    it('leaves a blank line inside a fence bare, as the fence is opaque to the outline', () => {
        const result = insert(['- Kitchen', '- After'], 0, ['```sh', 'water', '', 'mulch', '```'])
        expect(result.text).toBe('- Kitchen\n  ```sh\n  water\n\n  mulch\n  ```\n- After')
    })

    it('leaves the caret at the end of a block that is not a fence', () => {
        const result = insert(['Intro', ''], 1, ['Garden notes'])
        expect(result.text).toBe('Intro\nGarden notes')
        expect(result.caret).toBe(result.text.length)
    })
})

describe('a block that would break the outline', () => {
    const at = (doc: string, line: number) => {
        const s = EditorState.create({ doc, extensions: [editorAnalysis()] })
        return s.update({ selection: { anchor: s.doc.line(line + 1).to } }).state
    }

    it('is refused when a line of it would end the branch it sits in, or move a later line to another parent', () => {
        // A heading below the block's first line ends every branch, and so does a bare blank line in
        // a fence the editor does not pair.
        expect(blockInsertPlan(at('- Garden\n  - Kitchen\n  - Shed', 1), '- Agent Chat\n  # Heading\n  - Q')).toBeNull()
        expect(blockInsertPlan(at('- Garden\n  - Kitchen\n  - Shed', 1), '- Agent Chat\n  ~~~\n\n  # water\n  ~~~')).toBeNull()
    })

    it('goes in when it keeps the outline around it', () => {
        expect(blockInsertPlan(at('- Garden\n  - Kitchen\n  - Shed', 1), '- Agent Chat\n  - Q')).not.toBeNull()
    })
})

describe('where a block may go', () => {
    const state = (protectedDocument: boolean) =>
        EditorState.create({ doc: 'Intro\n\nAfter', selection: { anchor: 'Intro\n'.length }, extensions: [editorAnalysis(), isProtectedDocumentFacet.of(() => protectedDocument)] })

    it('is an empty line of an ordinary document', () => {
        expect(blockInsertable(state(false))).toBe(true)
    })

    // As a pasted link never becomes a fence there: a Protected Document draws no widget.
    afterEach(() => setActiveProtectionStatus(null))

    it('is nowhere in a Protected Document, unlocked or not', () => {
        expect(blockInsertable(state(true))).toBe(false)
        const unlocked: ProtectionStatus = { reasonAt: () => 'locked', isReadable: () => true, requestUnlock() {}, lockNow() {} }
        setActiveProtectionStatus(unlocked)
        expect(blockInsertable(state(true))).toBe(false)
    })
})
