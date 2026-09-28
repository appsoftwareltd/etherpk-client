/**
 * The typing rules inside [[Frontmatter]] (Editor Content Rules.md → Frontmatter), executable.
 *
 * The same row shape and fixture notation as `outliner-keymap.rules.test.ts`: the fixture before
 * the key, the key, the fixture after, and the editor the behaviour is modelled on. The fixture's
 * `key()` runs the frontmatter bindings before the outliner's, as the live keymap does.
 */

import { EditorSelection } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorFixture } from './testing/editor-state-fixture'

interface Rule {
    rule: string
    precedent: 'Logseq' | 'Obsidian' | 'VS Code' | 'CommonMark' | 'EtherPK'
    before: string
    key: string
    after: string
}

/** A block scalar's `|` is the fixture's own caret marker, so rows holding one mark the caret with `¦`. */
function press(before: string, key: string): string {
    const caret = before.includes('¦') ? '¦' : '|'
    const editor = editorFixture(before, { caret })
    editor.key(key)
    return editor.fixture()
}

function table(name: string, rows: Rule[]) {
    describe(name, () => {
        for (const row of rows) {
            it(`${row.key}: ${row.rule} (${row.precedent})`, () => {
                expect(press(row.before, row.key)).toBe(row.after)
            })
        }
    })
}

table('Enter keeps YAML indentation', [
    { rule: 'after a key and its value, the next key starts at the same indent', precedent: 'VS Code', before: '---\ntitle: A|\n---\n', key: 'Enter', after: '---\ntitle: A\n|\n---\n' },
    { rule: 'after a key with no value, the next line is one level in', precedent: 'VS Code', before: '---\naliases:|\n---\n', key: 'Enter', after: '---\naliases:\n  |\n---\n' },
    { rule: 'a nested key keeps its level', precedent: 'VS Code', before: '---\npublication:\n  id: docs|\n---\n', key: 'Enter', after: '---\npublication:\n  id: docs\n  |\n---\n' },
    { rule: 'a list item continues the list', precedent: 'EtherPK', before: '---\naliases:\n  - Board|\n---\n', key: 'Enter', after: '---\naliases:\n  - Board\n  - |\n---\n' },
    { rule: 'an empty list item continues it too: Enter creates, never escapes (ADR 0019)', precedent: 'EtherPK', before: '---\naliases:\n  - |\n---\n', key: 'Enter', after: '---\naliases:\n  - \n  - |\n---\n' },
    { rule: 'mid-item, the rest of the item becomes the next one', precedent: 'EtherPK', before: '---\naliases:\n  - Bo|ard\n---\n', key: 'Enter', after: '---\naliases:\n  - Bo\n  - |ard\n---\n' },
    { rule: 'on the closing delimiter, Enter is a body key as ever', precedent: 'EtherPK', before: '---\ntitle: A\n---|\n', key: 'Enter', after: '---\ntitle: A\n---\n|\n' },
])

table('Mod+Enter leaves a list or a mapping one level out', [
    { rule: 'from a list item, a new key at the list’s key level', precedent: 'EtherPK', before: '---\naliases:\n  - Bo|ard\n---\n', key: 'Mod-Enter', after: '---\naliases:\n  - Board\n|\n---\n' },
    { rule: 'from a nested key, a new key at its parent’s level', precedent: 'EtherPK', before: '---\npublication:\n  id: docs|\n---\n', key: 'Mod-Enter', after: '---\npublication:\n  id: docs\n|\n---\n' },
    { rule: 'from an empty item, the item becomes that line: no empty entry is left', precedent: 'EtherPK', before: '---\naliases:\n  - a\n  - |\n---\n', key: 'Mod-Enter', after: '---\naliases:\n  - a\n|\n---\n' },
])

table('Tab and Shift+Tab indent by two spaces, never a tab character', [
    { rule: 'Tab indents the line, the caret staying on its character, as in the outline', precedent: 'EtherPK', before: '---\npublication:\nid|: docs\n---\n', key: 'Tab', after: '---\npublication:\n  id|: docs\n---\n' },
    { rule: 'Tab at the start of a line indents it', precedent: 'VS Code', before: '---\npublication:\n|id: docs\n---\n', key: 'Tab', after: '---\npublication:\n  |id: docs\n---\n' },
    { rule: 'Tab over a selection indents every line of it', precedent: 'VS Code', before: '---\nx:\n«a: 1\nb: 2»\n---\n', key: 'Tab', after: '---\nx:\n  «a: 1\n  b: 2»\n---\n' },
    { rule: 'a selection of whole lines, ending at the start of the next, leaves that line alone', precedent: 'VS Code', before: '---\nx:\n«a: 1\nb: 2\n»---\n', key: 'Tab', after: '---\nx:\n  «a: 1\n  b: 2\n»---\n' },
    { rule: '…inside the block too', precedent: 'VS Code', before: '---\nx:\n«a: 1\n»b: 2\n---\n', key: 'Tab', after: '---\nx:\n  «a: 1\n»b: 2\n---\n' },
    { rule: 'Shift+Tab never outdents an indented --- to the margin, where it would close the block', precedent: 'EtherPK', before: '---\nnote: |\n  ¦---\n  more\ntitle: A\n---\n- body', key: 'Shift-Tab', after: '---\nnote: |\n  ¦---\n  more\ntitle: A\n---\n- body' },
    { rule: 'Shift+Tab outdents one level', precedent: 'VS Code', before: '---\npublication:\n    id|: docs\n---\n', key: 'Shift-Tab', after: '---\npublication:\n  id|: docs\n---\n' },
    { rule: 'Shift+Tab takes away what indent there is', precedent: 'VS Code', before: '---\n |id: docs\n---\n', key: 'Shift-Tab', after: '---\n|id: docs\n---\n' },
])

table('Backspace', [
    { rule: 'on an empty list item removes the marker and its indent', precedent: 'EtherPK', before: '---\naliases:\n  - |\n---\n', key: 'Backspace', after: '---\naliases:\n|\n---\n' },
    { rule: 'in the indentation removes one level', precedent: 'VS Code', before: '---\npublication:\n    |id: docs\n---\n', key: 'Backspace', after: '---\npublication:\n  |id: docs\n---\n' },
    { rule: 'in a value deletes a character as ever', precedent: 'VS Code', before: '---\ntitle: Ab|\n---\n', key: 'Backspace', after: '---\ntitle: A|\n---\n' },
    { rule: 'never takes a --- to the margin a level at a time: one space goes, as ever', precedent: 'EtherPK', before: '---\nnote: >\n  ¦---\n---\n', key: 'Backspace', after: '---\nnote: >\n ¦---\n---\n' },
    { rule: '…and not at all when that would leave it at the margin', precedent: 'EtherPK', before: '---\nnote: >\n ¦---\n---\n', key: 'Backspace', after: '---\nnote: >\n ¦---\n---\n' },
])

describe('pasting into the frontmatter', () => {
    it('writes a pasted tab indent as two spaces a level (EtherPK)', () => {
        const editor = editorFixture('---\n|\n---\n- body\n')
        editor.paste('publication:\n\tid: docs\n\t\tnested: x')
        expect(editor.fixture()).toBe('---\npublication:\n  id: docs\n    nested: x|\n---\n- body\n')
    })

    it('keeps a drop’s own selection, over the respaced text', () => {
        const editor = editorFixture('---\n|\n---\n- body\n')
        const from = editor.head()
        const dropped = 'a:\n\tb: 1'
        editor.dispatch(editor.state.update({ changes: { from, insert: dropped }, selection: EditorSelection.range(from, from + dropped.length), userEvent: 'input.drop' }))
        expect(editor.fixture()).toBe('---\n«a:\n  b: 1»\n---\n- body\n')
    })

    it('leaves a paste into the body alone', () => {
        const editor = editorFixture('---\ntitle: A\n---\n|\n')
        editor.paste('```\n\tcode\n```')
        expect(editor.text()).toContain('\tcode')
    })
})
