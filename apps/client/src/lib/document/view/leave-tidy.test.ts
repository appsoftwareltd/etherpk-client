/**
 * Tidy on leave (Editor Content Rules → *Tidy on leave*): the ghost whitespace a block or prose line
 * is left with is trimmed as the caret leaves it, and only then.
 */

import { describe, expect, it } from 'vitest'

import { tidiedAfterChildren, tidiedBlock, tidiedProse, tidyTargetAt } from './leave-tidy'
import { editorFixture } from './testing/editor-state-fixture'

const L = (s: string) => s.split('\n')

describe('tidiedBlock', () => {
    it('trims the space after the marker and trailing whitespace on every own line', () => {
        expect(tidiedBlock(L('-   a  \n  soft \t\n- b'), 0)?.lines).toEqual(['- a', '  soft'])
        expect(tidiedBlock(L('- [ ]   task  '), 0)?.lines).toEqual(['- [ ] task'])
    })

    it('removes whitespace-only soft lines at the end of the block, never the ones between content', () => {
        expect(tidiedBlock(L('- a\n  \n  b\n  \n   \n- c'), 0)?.lines).toEqual(['- a', '  ', '  b'])
        expect(tidiedBlock(L('- a\n  \n  - child'), 0)?.lines).toEqual(['- a'])
    })

    it('pulls the first content line up onto an empty bullet line, dropping the blank soft lines before it', () => {
        expect(tidiedBlock(L('- \n  \n  text\n  more'), 0)?.lines).toEqual(['- text', '  more'])
        expect(tidiedBlock(L('- [ ] \n  text'), 0)?.lines).toEqual(['- [ ] text'])
        // A deeper continuation keeps its place: its indentation may be meaning (an indented code block).
        expect(tidiedBlock(L('- \n      code'), 0)).toBeNull()
        // Only blank soft lines after an empty bullet: they were trailing.
        expect(tidiedBlock(L('- \n  \n  '), 0)?.lines).toEqual(['- '])
    })

    it('never touches fenced code inside the block, its fence lines included, nor a form-1 opener', () => {
        expect(tidiedBlock(L('- a  \n  ```  \n  code  \n  \n  ```\n  after  '), 0)?.lines).toEqual(['- a', '  ```  ', '  code  ', '  ', '  ```', '  after'])
        expect(tidiedBlock(L('- ```\n  x  \n  ```'), 0)).toBeNull()
        // An empty bullet over a form-2 fence is left as it is: pulling the fence up would change its form.
        expect(tidiedBlock(L('- \n  ```\n  x\n  ```'), 0)).toBeNull()
    })

    it('returns null for a block that is already tidy', () => {
        expect(tidiedBlock(L('- a\n  soft\n  \n  more\n- b'), 0)).toBeNull()
    })
})

describe('tidiedAfterChildren', () => {
    it('trims the block’s lines after its children and drops whitespace-only lines at the block’s end', () => {
        expect(tidiedAfterChildren(L('- a\n  - b\n  trailing  \n  \n- c'), 0)).toEqual([{ from: 2, to: 3, lines: ['  trailing'] }])
        expect(tidiedAfterChildren(L('- a\n  - b\n  '), 0)).toEqual([{ from: 2, to: 2, lines: [] }])
        // A blank soft line between a child and a paragraph is the paragraph break other readers need.
        expect(tidiedAfterChildren(L('- a\n  - b\n  \n  trailing'), 0)).toEqual([])
        // A run before a later child keeps its blank lines; only the last run has trailing newlines.
        expect(tidiedAfterChildren(L('- a\n  - b\n  t1 \n  \n  - c\n  t2 '), 0)).toEqual([
            { from: 2, to: 3, lines: ['  t1', '  '] },
            { from: 5, to: 5, lines: ['  t2'] },
        ])
        expect(tidiedAfterChildren(L('- a\n  - b'), 0)).toEqual([])
    })
})

describe('tidiedProse', () => {
    it('trims trailing whitespace and up to three leading spaces; keeps an indented code block and a tab', () => {
        expect(tidiedProse('text  ')).toBe('text')
        expect(tidiedProse('  text')).toBe('text')
        expect(tidiedProse('   # heading ')).toBe('# heading')
        expect(tidiedProse('    code  ')).toBe('    code')
        expect(tidiedProse('\tcode')).toBeNull()
        expect(tidiedProse('text')).toBeNull()
    })

    it('empties a whitespace-only line', () => {
        expect(tidiedProse('   ')).toBe('')
        expect(tidiedProse('')).toBeNull()
    })
})

describe('tidyTargetAt', () => {
    it('is the owning block for a bullet, its soft lines and its fence; a prose line for prose; nothing for code, frontmatter or a bare blank', () => {
        const lines = L('---\nt: x\n---\n- a\n  soft\n  ```\n  x\n  ```\nprose\n\n```\ntop\n```')
        expect(tidyTargetAt(lines, 1)).toBeNull()
        expect(tidyTargetAt(lines, 3)).toEqual({ kind: 'block', owner: 3 })
        expect(tidyTargetAt(lines, 4)).toEqual({ kind: 'block', owner: 3 })
        expect(tidyTargetAt(lines, 6)).toEqual({ kind: 'block', owner: 3 })
        expect(tidyTargetAt(lines, 8)).toEqual({ kind: 'prose', line: 8 })
        expect(tidyTargetAt(lines, 9)).toBeNull()
        expect(tidyTargetAt(lines, 11)).toBeNull()
    })

    it('a continuation after the block’s children belongs to that block, not to prose', () => {
        // A paragraph after a sublist, as CommonMark writes it. Reading it as prose stripped its indent
        // the moment the caret left, turning the paragraph into a group boundary (2026-09-22).
        const lines = L('- a\n  - b\n  \n  trailing\n- c')
        expect(tidyTargetAt(lines, 3)).toEqual({ kind: 'block', owner: 0 })
        const editor = editorFixture('- a\n  - b\n  \n  trailing|\n- c')
        editor.select(editor.text().length)
        expect(editor.text()).toBe('- a\n  - b\n  \n  trailing\n- c')
    })

    it('leaving a line after the children tidies it as the block’s own: trailing spaces go, a blank at the end goes with its line break', () => {
        const trailing = editorFixture('- a\n  - b\n  trailing   |\n- c')
        trailing.select(trailing.text().length)
        expect(trailing.text()).toBe('- a\n  - b\n  trailing\n- c')
        const blank = editorFixture('- a\n  - b\n  |\n- c')
        blank.select(blank.text().length)
        expect(blank.text()).toBe('- a\n  - b\n- c')
    })
})

describe('leave-tidy filter', () => {
    it('trims the block the caret leaves, in the same transaction as the move; the block it enters is untouched', () => {
        const editor = editorFixture('- a  |\n- b  ')
        editor.select(8) // into b
        expect(editor.fixture()).toBe('- a\n- |b  ')
    })

    it('does nothing while the caret moves within the block, soft lines included', () => {
        const editor = editorFixture('- a  |\n  \n- b')
        editor.select(6) // onto a's soft line
        expect(editor.fixture()).toBe('- a  \n  |\n- b')
    })

    it('a key that creates the next block tidies the one it came from: Enter after a trailing space', () => {
        const editor = editorFixture('- a |')
        editor.key('Enter')
        expect(editor.fixture()).toBe('- a\n- |')
    })

    it('leaving an empty soft line after Shift+Enter removes it', () => {
        const editor = editorFixture('- a|\n- b')
        editor.key('Shift-Enter')
        expect(editor.fixture()).toBe('- a\n  |\n- b')
        editor.select(editor.text().length) // click into b
        expect(editor.fixture()).toBe('- a\n- b|')
    })

    it('trims a prose line on leave, and never a fenced block or the frontmatter', () => {
        const editor = editorFixture('---\nt: x  \n---\ntext  |\n```\ncode  \n```')
        editor.select(editor.text().length - 5) // into the code
        expect(editor.text()).toBe('---\nt: x  \n---\ntext\n```\ncode  \n```')
        editor.select(6) // into the frontmatter, leaving the code
        expect(editor.text()).toBe('---\nt: x  \n---\ntext\n```\ncode  \n```')
    })

    it('keeps the caret where the move put it when the tidy shortens the block above', () => {
        const editor = editorFixture('- \n  \n  text|\n- b')
        editor.select(editor.text().length) // end of b
        expect(editor.fixture()).toBe('- text\n- b|')
    })

    it('is undone together with the move, and leaves undo and redo themselves alone', () => {
        const editor = editorFixture('- a  |\n- b')
        editor.select(8)
        expect(editor.text()).toBe('- a\n- b')
        editor.key('Mod-z')
        expect(editor.fixture()).toBe('- a  |\n- b')
    })
})
