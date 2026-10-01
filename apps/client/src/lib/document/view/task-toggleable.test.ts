import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'

import { editorAnalysis } from './analysis/editor-analysis'
import { bulletToggleOn, indentable, outlinerBulletAtCaret, taskToggleable } from './task-toggleable'

/**
 * A state with the caret on the line containing `marker` (at its start). Carries the editor
 * analysis field, as every real editor does — `taskToggleable` reads frontmatter from it.
 */
function at(doc: string, marker: string): EditorState {
    const anchor = doc.indexOf(marker)
    if (anchor < 0) throw new Error(`no ${marker}`)
    return EditorState.create({ doc, selection: { anchor }, extensions: [editorAnalysis()] })
}

describe('taskToggleable', () => {
    it('is true on bullets and tasks — the cycle applies', () => {
        expect(taskToggleable(at('- a bullet', 'a bullet'))).toBe(true)
        expect(taskToggleable(at('- [x] done', 'done'))).toBe(true)
    })

    it('is true on prose, where the toggle makes the line a task', () => {
        expect(taskToggleable(at('Buy milk', 'Buy'))).toBe(true)
        expect(taskToggleable(at('above\n\nbelow', '\n\n'))).toBe(true) // an empty line
    })

    it('refuses a heading — `- [ ] # Title` is neither a task nor a heading', () => {
        expect(taskToggleable(at('# Title', 'Title'))).toBe(false)
    })

    it('refuses a line inside a fenced code block', () => {
        expect(taskToggleable(at('```\ncode here\n```', 'code'))).toBe(false)
    })

    it('refuses a bullet-shaped line in code or in the frontmatter: code and YAML, not a bullet', () => {
        expect(taskToggleable(at('- ```md\n  - x\n  ```', '- x'))).toBe(false)
        expect(taskToggleable(at('---\ntags:\n  - foo\n---', '- foo'))).toBe(false)
    })

    it('refuses a form-1 opener: a task marker would push its fence off the content column', () => {
        expect(taskToggleable(at('- ```py\n  x\n  ```', '```py'))).toBe(false)
    })

    it('refuses frontmatter', () => {
        expect(taskToggleable(at('---\ntitle: x\n---\nbody', 'title'))).toBe(false)
        expect(taskToggleable(at('---\ntitle: x\n---\nbody', 'body'))).toBe(true)
    })

    it('refuses a table row: as a task it would leave its table behind', () => {
        const table = '| a | b |\n| --- | --- |\n| 1 | 2 |'
        expect(taskToggleable(at(table, 'a'))).toBe(false)
        expect(taskToggleable(at(table, '1'))).toBe(false)
        expect(taskToggleable(at(`- notes\n  ${table.replaceAll('\n', '\n  ')}`, '1'))).toBe(false)
        // The bullet line a table opens on is a bullet, and cycles like one.
        expect(taskToggleable(at('- | a | b |\n  | --- | --- |\n  | 1 | 2 |', 'a'))).toBe(true)
    })
})

/**
 * Where Indent (the `editor.indent` Command: Tab, and the Command Bar's Indent button) acts: a bullet
 * nests, a form-1 opener included, since it is the bullet its code block belongs to; prose enters the
 * list. A heading, code and frontmatter do not take it.
 */
/** A state with `from`..`to` selected (the text between the first and second markers). */
function range(doc: string, from: string, to: string): EditorState {
    const anchor = doc.indexOf(from)
    const head = doc.indexOf(to) + to.length
    return EditorState.create({ doc, selection: { anchor, head }, extensions: [editorAnalysis()] })
}

/**
 * The task button's gate reads a range as Mod+Shift+Enter does: a range across one block's lines
 * cycles that block wherever its head sits, so the button is live there even with the head on one of
 * the block's table rows or in its code. A form-1 block refuses, its code block would break.
 */
describe('taskToggleable over a range across one block’s lines', () => {
    it('is live on the block, with the head on one of its table rows or in its code', () => {
        expect(taskToggleable(range('- notes\n  | a | b |\n  | --- | --- |\n  | 1 | 2 |', 'notes', '1'))).toBe(true)
        expect(taskToggleable(range('- a\n  ```\n  code\n  ```', 'a', 'co'))).toBe(true)
    })

    it('is refused on a form-1 block, with the head on a line after its closer too', () => {
        expect(taskToggleable(range('- ```py\n  code\n  ```\n  after', 'py', 'af'))).toBe(false)
    })
})

describe('indentable', () => {
    it('is true over a range across one block’s lines, wherever its head sits: Indent acts on the block', () => {
        expect(indentable(range('- a\n- b\n  ```\n  code\n  ```', 'b', 'co'))).toBe(true)
    })

    it('is false on an unterminated fence line: as a bullet it would take the next fence for its closer', () => {
        expect(indentable(at('```py\n- b\n  ```\n  code\n  ```', '```py'))).toBe(false)
    })

    it('is true on bullets, a form-1 opener included, and on prose', () => {
        expect(indentable(at('- a\n- b', '- b'))).toBe(true)
        expect(indentable(at('- a\n- ```py\n  x\n  ```', '```py'))).toBe(true)
        expect(indentable(at('text', 'text'))).toBe(true)
    })

    it('is false on a table row, which as a block would leave its table behind', () => {
        expect(indentable(at('| a | b |\n| --- | --- |\n| 1 | 2 |', '1'))).toBe(false)
    })

    it('is false on a heading, on code and in the frontmatter', () => {
        expect(indentable(at('# Title', 'Title'))).toBe(false)
        expect(indentable(at('- ```md\n  - x\n  ```', '- x'))).toBe(false)
        expect(indentable(at('---\ntags:\n  - foo\n---', '- foo'))).toBe(false)
    })
})

/**
 * The Outdent and Move buttons' gate: the caret on a bullet of the outline, a form-1 opener included.
 * A bullet-shaped line in code or in the frontmatter is code or YAML, and the commands leave it be.
 */
describe('outlinerBulletAtCaret', () => {
    it('is true on a bullet and on a form-1 opener', () => {
        expect(outlinerBulletAtCaret(at('- a\n- b', '- b'))).toBe(true)
        expect(outlinerBulletAtCaret(at('- ```py\n  x\n  ```', '```py'))).toBe(true)
    })

    it('is false on prose, on a bullet-shaped code line and on a YAML list entry', () => {
        expect(outlinerBulletAtCaret(at('text', 'text'))).toBe(false)
        expect(outlinerBulletAtCaret(at('```md\n- in fence\n```', '- in'))).toBe(false)
        expect(outlinerBulletAtCaret(at('---\ntags:\n  - foo\n---', '- foo'))).toBe(false)
    })
})

/**
 * The bullet button's pressed state (`aria-pressed` on the Command Bar): on while the line the toggle
 * acts on is a bullet, nested or not, so the button says which way a tap goes even where it is greyed.
 * The gate itself is checked row by row beside the toggle's rule table (outliner-keymap.rules.test.ts).
 */
describe('bulletToggleOn', () => {
    it('is on for a bullet, a task and a form-1 opener, nested or not', () => {
        expect(bulletToggleOn(at('- a\n  - b', '- b'))).toBe(true)
        expect(bulletToggleOn(at('- [ ] task', 'task'))).toBe(true)
        expect(bulletToggleOn(at('- ```py\n  x\n  ```', '```py'))).toBe(true)
    })

    it('is on over a range across one block’s lines, which toggles that block', () => {
        expect(bulletToggleOn(range('- a\n  soft', 'a', 'so'))).toBe(true)
    })

    it('is off on prose, a continuation, a heading, code and a YAML list entry', () => {
        expect(bulletToggleOn(at('text', 'text'))).toBe(false)
        expect(bulletToggleOn(at('- a\n  soft', 'soft'))).toBe(false)
        expect(bulletToggleOn(at('# Title', 'Title'))).toBe(false)
        expect(bulletToggleOn(at('```md\n- in fence\n```', '- in'))).toBe(false)
        expect(bulletToggleOn(at('---\ntags:\n  - foo\n---', '- foo'))).toBe(false)
    })

    it('is off over a selection across blocks, which the toggle refuses', () => {
        expect(bulletToggleOn(range('- a\n- b', 'a', 'b'))).toBe(false)
    })
})
