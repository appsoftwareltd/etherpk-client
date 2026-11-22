import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { parseListItem } from '../list-items'

import { listItemBindings, plainLists } from './list-items-keymap'
import { editorFixture } from './testing/editor-state-fixture'

/**
 * The outliner's keys on `*`, `+` and numbered lists (ADR 0195), over any list of those kinds:
 *
 * - Tab then Shift+Tab gives the text back. A person who nests an item by mistake gets their file
 *   back, bytes and all, without Undo.
 * - Neither key changes a line outside the item's own branch, or any text after a line's indent.
 * - Enter adds exactly one line and loses no text.
 *
 * Fixed seed and run count. `EDITOR_FUZZ_RUNS` and `EDITOR_FUZZ_SEED` change them.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261121 : Number(seed) }
}

const marker = fc.constantFrom('*', '+', '1.', '2.', '7)')
const word = fc.constantFrom('beds', 'fence', 'water the beans', 'dig', 'sow', '[link](a.md)', '**bold**', '')

/**
 * A list as a file holds one: each item is a sibling of the one above, its child, or back out at
 * an ancestor's level. A child sits on its parent's content column, as CommonMark nests it.
 */
const list = fc.array(fc.tuple(marker, word, fc.constantFrom('same', 'deeper', 'out')), { minLength: 1, maxLength: 8 }).map((items) => {
    const lines: string[] = []
    /** The indent of each open level, outermost first. */
    const levels: string[] = ['']
    items.forEach(([mark, text, move], index) => {
        if (index > 0 && move === 'deeper') {
            const above = parseListItem(lines[lines.length - 1])!
            levels.push(' '.repeat(above.indent.length + above.marker.length + above.gap.length))
        } else if (move === 'out' && levels.length > 1) levels.pop()
        lines.push(`${levels[levels.length - 1]}${mark} ${text === '' ? 'item' : text}`)
    })
    return lines
})

function press(lines: readonly string[], caretLine: number, key: string): { text: string; changed: boolean } {
    const before = lines.join('\n')
    const offset = lines.slice(0, caretLine).reduce((sum, line) => sum + line.length + 1, 0) + lines[caretLine].length
    const editor = editorFixture(`${before.slice(0, offset)}¦${before.slice(offset)}`, { withoutFilters: true, caret: '¦', extensions: [plainLists.of(true)] })
    for (const binding of listItemBindings()) {
        if (binding.key === key && binding.run?.(editor as never)) break
    }
    return { text: editor.text(), changed: editor.text() !== before }
}

const afterIndent = (line: string) => line.replace(/^[ \t]*/, '')

describe('the keys on other list kinds, over any list', () => {
    it('Tab then Shift+Tab gives the text back', () => {
        fc.assert(
            fc.property(list, fc.nat(), (lines, pick) => {
                const at = pick % lines.length
                const nested = press(lines, at, 'Tab')
                if (!nested.changed) return
                expect(press(nested.text.split('\n'), at, 'Shift-Tab').text).toBe(lines.join('\n'))
            }),
            fuzz(1500),
        )
    })

    it('Tab and Shift+Tab change only indents, and only in the item’s own branch', () => {
        fc.assert(
            fc.property(list, fc.nat(), fc.constantFrom('Tab', 'Shift-Tab'), (lines, pick, key) => {
                const at = pick % lines.length
                const after = press(lines, at, key).text.split('\n')
                expect(after.map(afterIndent)).toEqual(lines.map(afterIndent))
                // Above the item nothing moves.
                expect(after.slice(0, at)).toEqual(lines.slice(0, at))
                // Everything under the item moves with it, by as much, and nothing after that moves.
                const width = (line: string) => line.length - afterIndent(line).length
                const moved = width(after[at]) - width(lines[at])
                let under = true
                for (let index = at + 1; index < lines.length; index++) {
                    if (width(lines[index]) <= width(lines[at])) under = false
                    expect(width(after[index]) - width(lines[index]), `line ${index}`).toBe(under ? moved : 0)
                }
            }),
            fuzz(1500),
        )
    })

    it('Enter at the end of an item adds one line and keeps every word', () => {
        fc.assert(
            fc.property(list, fc.nat(), (lines, pick) => {
                const at = pick % lines.length
                const after = press(lines, at, 'Enter').text.split('\n')
                expect(after).toHaveLength(lines.length + 1)
                const words = (all: readonly string[]) => all.map((line) => parseListItem(line)?.content ?? line).filter((text) => text !== '')
                expect(words(after)).toEqual(words(lines))
                // The new item is on the item's own level, with a marker of its kind.
                const fresh = parseListItem(after[at + 1])
                expect(fresh?.indent).toBe(parseListItem(lines[at])!.indent)
            }),
            fuzz(1500),
        )
    })
})
