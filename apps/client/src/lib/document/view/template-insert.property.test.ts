import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { insertTemplate } from './template-insert'
import { editorFixture } from './testing/editor-state-fixture'

/**
 * `{{cursor}}` only says where the caret goes (ADR 0144). Wherever an author puts it, the Template
 * must land as exactly the same text as it does with no cursor, the caret must land inside what was
 * inserted, and the character the cursor travels as must never be left in the document. Bodies are
 * built from outline lines, prose, headings, a fence and blank lines, the shapes Templates take.
 */

function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261014 : Number(seed) }
}

const line = fc.oneof(
    fc.constantFrom('- Review', '  - water the beans', '    - [ ] buy seeds', '- [ ] plan', 'Notes for the week', '## Morning', '', '- Mood: '),
    fc.constant('- ```js\n  x = 1\n  ```'),
    fc.constant('- Code\n  ```\n  y\n\n  ```'),
)

const body = fc.array(line, { minLength: 1, maxLength: 6 }).map((lines) => lines.join('\n'))

const before = fc.constantFrom('- |', '- Garden\n- |', '- Garden|', 'Intro\n|', '|', '- a\n  - b|', '- Met |today')

/** Every private-use character a mark could be, which no generated Template holds. */
const PRIVATE_USE = /[-]/

describe('a Template’s {{cursor}} changes where the caret goes and nothing else', () => {
    it('lands the same text as the Template without one, with the caret inside the insert', () => {
        fc.assert(
            fc.property(before, body, fc.nat(), (start, text, pick) => {
                const plain = editorFixture(start)
                insertTemplate(plain, { text, cursor: null })

                const cursor = pick % (text.length + 1)
                const withCursor = editorFixture(start)
                insertTemplate(withCursor, { text, cursor })

                // Tidy on leave trims the trailing space of a block the caret left, so where the caret
                // ends decides when that happens. Nothing else may differ.
                const settled = (text: string) => text.replace(/[ \t]+$/gm, '')
                expect(settled(withCursor.text())).toBe(settled(plain.text()))
                expect(PRIVATE_USE.test(withCursor.text())).toBe(false)
                const head = withCursor.head()
                expect(head).toBeGreaterThanOrEqual(0)
                expect(head).toBeLessThanOrEqual(withCursor.text().length)
            }),
            fuzz(400),
        )
    })
})
