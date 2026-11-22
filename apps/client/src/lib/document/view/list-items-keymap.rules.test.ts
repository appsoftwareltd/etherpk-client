import { describe, expect, it } from 'vitest'

import { listItemAt, listStructure, nestedIndent, parseListItem } from '../list-items'

import { listItemBindings, plainLists } from './list-items-keymap'
import { editorFixture } from './testing/editor-state-fixture'

/**
 * The outliner's keys on `*`, `+` and numbered lists in a Plain Folder (ADR 0195), one row to a
 * rule. `|` is the caret. Each row names where the behaviour comes from.
 */
interface Rule {
    rule: string
    precedent: 'CommonMark' | 'Obsidian' | 'EtherPK (ADR 0195)'
    before: string
    key: 'Tab' | 'Shift-Tab' | 'Enter'
    after: string
}

/** Press a key as the plain profile binds it: these bindings first, then the outliner's and the defaults. */
function press(before: string, key: string): string {
    const editor = editorFixture(before, { withoutFilters: true, extensions: [plainLists.of(true)] })
    for (const binding of listItemBindings()) {
        if (binding.key === key && binding.run?.(editor as never)) return editor.fixture()
    }
    editor.key(key)
    return editor.fixture()
}

const lines = (...text: string[]) => text.join('\n')

const RULES: Rule[] = [
    {
        rule: 'Tab nests a * item under the item above it, on that item’s content column',
        precedent: 'CommonMark',
        before: lines('* beds', '* fe|nce'),
        key: 'Tab',
        after: lines('* beds', '  * fe|nce'),
    },
    {
        rule: 'Tab nests a numbered item three columns in, where the text of `1. ` starts',
        precedent: 'CommonMark',
        before: lines('1. dig', '2. so|w'),
        key: 'Tab',
        after: lines('1. dig', '   2. so|w'),
    },
    {
        rule: 'Tab takes the item’s own children with it, keeping their offsets',
        precedent: 'Obsidian',
        before: lines('+ beds', '+ fe|nce', '  + posts', '    + nails', '+ gate'),
        key: 'Tab',
        after: lines('+ beds', '  + fe|nce', '    + posts', '      + nails', '+ gate'),
    },
    {
        rule: 'Tab nests by the file’s own step where the file nests deeper than the content column',
        precedent: 'EtherPK (ADR 0195)',
        before: lines('* beds', '    * rows', '* fence', '* ga|te'),
        key: 'Tab',
        after: lines('* beds', '    * rows', '* fence', '    * ga|te'),
    },
    {
        rule: 'Tab nests by a tab where the file indents with tabs',
        precedent: 'EtherPK (ADR 0195)',
        before: lines('* beds', '\t* rows', '* fence', '* ga|te'),
        key: 'Tab',
        after: lines('* beds', '\t* rows', '* fence', '\t* ga|te'),
    },
    {
        rule: 'Tab lands beside the children the item above already has, as their sibling',
        precedent: 'CommonMark',
        before: lines('* beds', '    * rows', '   * paths', '* fe|nce', '', 'Notes.'),
        key: 'Tab',
        after: lines('* beds', '    * rows', '   * paths', '    * fe|nce', '', 'Notes.'),
    },
    {
        rule: 'Tab on a first item, which has nothing to nest under, changes nothing',
        precedent: 'Obsidian',
        before: lines('Tools:', '* sp|ade'),
        key: 'Tab',
        after: lines('Tools:', '* sp|ade'),
    },
    {
        rule: 'Tab nests a * item under a - bullet above it',
        precedent: 'CommonMark',
        before: lines('- beds', '* fe|nce'),
        key: 'Tab',
        after: lines('- beds', '  * fe|nce'),
    },
    {
        rule: 'Tab on a line that is no list item leaves it as it is',
        precedent: 'EtherPK (ADR 0195)',
        before: lines('Beds dry out fa|stest by the fence.'),
        key: 'Tab',
        after: lines('Beds dry out fa|stest by the fence.'),
    },
    {
        rule: 'Tab on a thematic break is not a list’s',
        precedent: 'CommonMark',
        before: lines('* beds', '* * *|'),
        key: 'Tab',
        after: lines('* beds', '* * *|'),
    },
    {
        rule: 'Shift+Tab lifts a nested item to its parent’s column, with its children',
        precedent: 'Obsidian',
        before: lines('1. dig', '   * so|w', '     * thin', '2. water'),
        key: 'Shift-Tab',
        after: lines('1. dig', '* so|w', '  * thin', '2. water'),
    },
    {
        rule: 'Shift+Tab on an item at the margin changes nothing',
        precedent: 'EtherPK (ADR 0195)',
        before: lines('* be|ds'),
        key: 'Shift-Tab',
        after: lines('* be|ds'),
    },
    {
        rule: 'Enter starts the next item with the same marker',
        precedent: 'Obsidian',
        before: lines('* beds|'),
        key: 'Enter',
        after: lines('* beds', '* |'),
    },
    {
        rule: 'Enter in the middle of an item carries the rest to the new item',
        precedent: 'Obsidian',
        before: lines('  + beds |by the fence'),
        key: 'Enter',
        after: lines('  + beds ', '  + |by the fence'),
    },
    {
        rule: 'Enter in a numbered list counts on, and the items after it follow',
        precedent: 'Obsidian',
        before: lines('1. dig|', '2. sow', '3. water', '', 'Then rest.'),
        key: 'Enter',
        after: lines('1. dig', '2. |', '3. sow', '4. water', '', 'Then rest.'),
    },
    {
        rule: 'Enter in a list numbered 1. throughout keeps the 1.',
        precedent: 'CommonMark',
        before: lines('1. dig', '1. sow|', '1. water'),
        key: 'Enter',
        after: lines('1. dig', '1. sow', '1. |', '1. water'),
    },
    {
        rule: 'Enter keeps the delimiter of a `1)` list',
        precedent: 'CommonMark',
        before: lines('3) dig|'),
        key: 'Enter',
        after: lines('3) dig', '4) |'),
    },
    {
        rule: 'Enter on a task starts an open task',
        precedent: 'Obsidian',
        before: lines('* [x] dig the bed|'),
        key: 'Enter',
        after: lines('* [x] dig the bed', '* [ ] |'),
    },
    {
        rule: 'Enter on an empty item ends the list',
        precedent: 'Obsidian',
        before: lines('* beds', '* |'),
        key: 'Enter',
        after: lines('* beds', '|'),
    },
    {
        rule: 'Enter on an empty nested item lifts it a level',
        precedent: 'Obsidian',
        before: lines('* beds', '  * rows', '  * |', '* fence'),
        key: 'Enter',
        after: lines('* beds', '  * rows', '* |', '* fence'),
    },
    {
        rule: 'Enter on the first item of a list numbered 1. throughout keeps the 1.',
        precedent: 'CommonMark',
        before: lines('1. dig|', '1. sow', '1. water'),
        key: 'Enter',
        after: lines('1. dig', '1. |', '1. sow', '1. water'),
    },
    {
        rule: 'Enter over a selection in an item replaces it with the break',
        precedent: 'Obsidian',
        before: lines('* beds «by »the fence'),
        key: 'Enter',
        after: lines('* beds ', '* |the fence'),
    },
    {
        rule: 'Enter that widens a number (9. to 10.) moves what is under that item in with its text',
        precedent: 'CommonMark',
        before: lines('8. dig|', '9. sow', '   * thin', '', 'After.'),
        key: 'Enter',
        after: lines('8. dig', '9. |', '10. sow', '    * thin', '', 'After.'),
    },
    {
        rule: 'Enter on a numbered line that only continues a paragraph is a plain line break',
        precedent: 'CommonMark',
        before: lines('The year was', '2025. It rained|'),
        key: 'Enter',
        after: lines('The year was', '2025. It rained', '|'),
    },
    {
        rule: 'Tab over a selection of items nests each of them, keeping their shape',
        precedent: 'Obsidian',
        before: lines('* beds', '* «fence', '* gate»', '* shed'),
        key: 'Tab',
        after: lines('* beds', '  * «fence', '  * gate»', '* shed'),
    },
    {
        rule: 'Shift+Tab over a selection of items lifts each of them',
        precedent: 'Obsidian',
        before: lines('* beds', '  * «fence', '  * gate»'),
        key: 'Shift-Tab',
        after: lines('* beds', '* «fence', '* gate»'),
    },
    {
        rule: 'Tab reads the file’s indent from its lists, not from a tab in a code block',
        precedent: 'EtherPK (ADR 0195)',
        before: lines('```', '\tgo build', '        * deep', '```', '* beds', '* fe|nce'),
        key: 'Tab',
        after: lines('```', '\tgo build', '        * deep', '```', '* beds', '  * fe|nce'),
    },
    {
        rule: 'Enter leaves the numbering of a deeper list alone',
        precedent: 'EtherPK (ADR 0195)',
        before: lines('1. dig|', '   1. first', '2. sow'),
        key: 'Enter',
        after: lines('1. dig', '2. |', '   1. first', '3. sow'),
    },
]

describe('the outliner’s keys on other list kinds, in a Plain Folder', () => {
    for (const row of RULES) {
        it(`${row.rule} [${row.precedent}]`, () => {
            expect(press(row.before, row.key)).toBe(row.after)
        })
    }

    it('leaves a - bullet, and a line in a fenced block, to the outliner', () => {
        expect(press(lines('- beds', '- fe|nce'), 'Tab')).toBe(lines('- beds', '  - fe|nce'))
        expect(press(lines('```', '* no|t a list', '```'), 'Enter')).toBe(lines('```', '* no', '|t a list', '```'))
    })
})

describe('reading a list item', () => {
    it('reads each marker, a task’s box and the text', () => {
        expect(parseListItem('  * [ ] dig')).toEqual({ indent: '  ', marker: '*', gap: ' ', box: '[ ] ', content: 'dig' })
        expect(parseListItem('12.  sow')).toEqual({ indent: '', marker: '12.', gap: '  ', box: '', content: 'sow' })
        expect(parseListItem('+ ')).toEqual({ indent: '', marker: '+', gap: ' ', box: '', content: '' })
    })

    it('is not a - bullet, emphasis, a rule, a year at a line’s start or a lone marker', () => {
        for (const text of ['- beds', '*beds*', '**Beds** dry out', '***', '* * *', '2025 was dry.', '1.5 metres', '*', '1.']) expect(parseListItem(text), text).toBeNull()
    })

    it('nests under an item by its content column', () => {
        expect(nestedIndent(['* a'], 0)).toBe('  ')
        expect(nestedIndent(['10. a'], 0)).toBe('    ')
        expect(nestedIndent(['  - a'], 0)).toBe('    ')
    })

    it('takes a numbered line after a paragraph for the paragraph, unless it starts at 1', () => {
        expect(listItemAt(['The year was', '2025. It rained'], 1)).toBeNull()
        expect(listItemAt(['Steps:', '1. dig'], 1)).not.toBeNull()
        expect(listItemAt(['1. dig', '2. sow'], 1)).not.toBeNull()
        expect(listItemAt(['* beds', '  wide ones', '3. sow'], 2)).not.toBeNull()
    })

    it('reads nothing in a code block or the frontmatter as a list', () => {
        expect(listStructure(['---', 'tags:', '* a', '---', '```', '* b', '```', '* c'])).toEqual(['', '', '', '', '', '', '', '* c'])
    })
})
