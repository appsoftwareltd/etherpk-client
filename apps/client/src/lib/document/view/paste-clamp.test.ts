/**
 * Paste and drop in Node: a block per line into an outliner block, the clamp into a fenced block, the
 * top-level heal into prose. Each case is a sentence from Editor Content Rules → *Pasting into a
 * block* or *The source clamp*.
 */

import { describe, expect, it } from 'vitest'

import { clampPastedText, healPastedBullets, healPastedTree } from './paste-clamp'
import { editorFixture } from './testing/editor-state-fixture'

function paste(before: string, text: string, event: 'input.paste' | 'input.drop' = 'input.paste'): string {
    const editor = editorFixture(before)
    editor.paste(text, event)
    return editor.fixture()
}

describe('clampPastedText', () => {
    it('indents every line after the first to the clamp and strips the fragment’s common indent', () => {
        expect(clampPastedText('a\nb\n  c', 2)).toBe('a\n  b\n    c')
        expect(clampPastedText('  a\n  b', 2)).toBe('a\n  b')
    })

    it('pads blank lines too, so they stay inside the block', () => {
        expect(clampPastedText('a\n\nb', 2)).toBe('a\n  \n  b')
    })

    it('leaves single-line and prose (clamp 0) pastes untouched', () => {
        expect(clampPastedText('a', 4)).toBe('a')
        expect(clampPastedText('a\nb', 0)).toBe('a\nb')
    })
})

describe('healPastedBullets', () => {
    it('pulls a level-jumped pasted bullet up to one level under the bullet before it', () => {
        expect(healPastedBullets('x\n    - y\n      - z', 0)).toBe('x\n  - y\n    - z')
        expect(healPastedBullets('x\n  - y', 0)).toBe('x\n  - y')
    })
})

describe('paste into a fenced block or prose: the clamp', () => {
    it('keeps a multi-line paste inside a bullet’s fenced block', () => {
        expect(paste('- ```\n  |\n  ```', 'one\ntwo\nthree')).toBe('- ```\n  one\n  two\n  three|\n  ```')
    })

    it('keeps a paste with column-0 links inside a nested fenced block', () => {
        expect(paste('- a\n  - ```\n    x|\n    ```', 'http://a\nhttp://b')).toBe('- a\n  - ```\n    xhttp://a\n    http://b|\n    ```')
    })

    it('leaves pasted lines inside a fence as code, bullets included', () => {
        expect(paste('- ```\n  |\n  ```', 'x\n    - y')).toBe('- ```\n  x\n      - y|\n  ```')
    })

    it('leaves a paste into the middle of prose exactly as pasted', () => {
        expect(paste('p|', 'one\ntwo')).toBe('pone\ntwo|')
        expect(paste('p|', '    - a\n      - b')).toBe('p    - a\n      - b|')
    })

    it('strips the copied indentation from blocks pasted onto a clean line, so they start a tree at the top level', () => {
        // Copied at depth three, pasted under nothing (2026-09-14): they must not land at depth three.
        expect(paste('|', '      - [ ] a\n        - b\n        - [ ] c\n          - d')).toBe('- [ ] a\n  - b\n  - [ ] c\n    - d|')
        expect(paste('x\n\n|', '  - a\n    - b\n')).toBe('x\n\n- a\n  - b\n|')
        expect(paste('|p', '  - a\n')).toBe('- a\n|p')
    })

    it('heals a pasted tree whose first line is prose: its first bullet lands at the top level', () => {
        expect(healPastedTree('  p\n      - a\n        - b')).toBe('p\n- a\n  - b')
    })

    it('leaves a paste into the frontmatter as YAML', () => {
        expect(paste('---\ntags:\n|\n---\n- b', '  - a\n  - c')).toBe('---\ntags:\n  - a\n  - c|\n---\n- b')
    })

    it('strips the indentation copied along with whole lines from inside a block', () => {
        expect(paste('- ```\n  |\n  ```', '  foo\n  bar')).toBe('- ```\n  foo\n  bar|\n  ```')
    })

    it('puts a foreign-grid fragment on the Indent Unit grid first, as an import would (ADR 0067)', () => {
        // A tab-indented Logseq tree, onto a clean line: normalised, then healed from the top level.
        expect(paste('|', '- x\n\t- y\n\t\t- z')).toBe('- x\n  - y\n    - z|')
        // A foreign fragment's continuation line keeps its excess beyond the content column.
        expect(paste('|', '- x\n    - y\n          deeper')).toBe('- x\n  - y\n        deeper|')
        // Code in the fragment is never normalised: a tab inside a pasted fence stays a tab.
        expect(paste('|', '- x\n  ```\n  \tcode\n  ```')).toBe('- x\n  ```\n  \tcode\n  ```|')
    })

    it('applies to a text drop as well as a paste, and not to typing', () => {
        expect(paste('- ```\n  |\n  ```', 'one\ntwo', 'input.drop')).toBe('- ```\n  one\n  two|\n  ```')
        const editor = editorFixture('- ```\n  |\n  ```')
        editor.dispatch(editor.state.update(editor.state.replaceSelection('one\ntwo'), { userEvent: 'input.type' }))
        expect(editor.text()).toBe('- ```\n  one\ntwo\n  ```')
    })
})

/**
 * Pasting into an outliner block (Editor Content Rules → *Pasting into a block*, ADR 0089): the first
 * line lands at the caret and every further non-blank line is a block of its own, as if each had been
 * typed after an Enter. Each row names its precedent like the keyboard tables do.
 */
describe('paste into a block: a block per line', () => {
    const rows: { rule: string; precedent: 'Logseq' | 'EtherPK'; before: string; text: string; after: string }[] = [
        // The report of 2026-09-22: prose, a list and a closing paragraph pasted into an empty bullet.
        { rule: 'prose lines become sibling blocks and the bullets between them nest under the line before', precedent: 'EtherPK', before: '- |', text: 'Test\nMultline \n\n- Block\n- Test\n\nMarkdown', after: '- Test\n- Multline \n  - Block\n  - Test\n- Markdown|' },
        { rule: 'the first line joins the caret’s block; the rest are its siblings', precedent: 'Logseq', before: '- a|\n- b', text: 'one\ntwo', after: '- aone\n- two|\n- b' },
        { rule: 'text after the caret follows the last pasted line, as typing would leave it', precedent: 'EtherPK', before: '- a|b', text: 'one\ntwo', after: '- aone\n- two|b' },
        { rule: 'at the start of a bullet’s content the whole content follows the last pasted line', precedent: 'EtherPK', before: '- |abc', text: 'one\ntwo', after: '- one\n- two|abc' },
        { rule: 'blank lines separate blocks and are dropped, the trailing newline too', precedent: 'Logseq', before: '- |', text: 'a\n\n\nb\n', after: '- a\n- b|' },
        { rule: 'into a task, the new blocks are tasks, as Enter makes them', precedent: 'EtherPK', before: '- [ ] a|', text: 'one\ntwo', after: '- [ ] aone\n- [ ] two|' },
        { rule: 'at the end of a block with children the new blocks are its first children', precedent: 'EtherPK', before: '- a|\n  - b', text: 'one\ntwo', after: '- aone\n  - two|\n  - b' },
        { rule: 'on a continuation line the block splits there, as Enter would', precedent: 'EtherPK', before: '- a\n  soft|', text: 'one\ntwo', after: '- a\n  softone\n- two|' },
        { rule: 'a nested block’s new siblings sit at its depth', precedent: 'EtherPK', before: '- a\n  - b|', text: 'one\n- x\nTwo', after: '- a\n  - bone\n    - x\n  - Two|' },
        // Bullets in the fragment.
        { rule: 'bullets before any prose line nest under the caret’s block', precedent: 'EtherPK', before: '- a|', text: '\n- x\n  - y', after: '- a\n  - x\n    - y|' },
        { rule: 'a bullet after a prose line nests under it, one level, plus its own nesting', precedent: 'EtherPK', before: '- a|', text: 'x\n  - y', after: '- ax\n  - y|' },
        { rule: 'an empty bullet takes a pasted bullet line whole, its task state included', precedent: 'Logseq', before: '- |', text: '- [ ] x\n- [x] y', after: '- [ ] x\n- [x] y|' },
        { rule: 'a single pasted bullet line too, so a copied block pastes as itself', precedent: 'Logseq', before: '- [ ] |', text: '- x', after: '- x|' },
        { rule: 'a pasted bullet joining a block with text drops its marker; its tree keeps its shape', precedent: 'EtherPK', before: '- a|', text: '- x\n  - y\n- z', after: '- ax\n  - y\n- z|' },
        // The merged root's descendants hang from the first-child indent when the block has children (found in review).
        { rule: 'a pasted tree merged into a block with children hangs from its first-child indent, never two levels down', precedent: 'EtherPK', before: '- a|\n  - c', text: '- x\n  - y', after: '- ax\n  - y|\n  - c' },
        { rule: 'and the root’s siblings become first children too, as Enter would make them', precedent: 'EtherPK', before: '- a|\n  - c', text: '- x\n  - y\n- z', after: '- ax\n  - y\n  - z|\n  - c' },
        { rule: 'a mixed tab and space fragment is read in columns before its indent is stripped', precedent: 'EtherPK', before: '- |', text: '  - x\n\t- y', after: '- x\n  - y|' },
        { rule: 'over a margin drag that leaves content, lines are blocks', precedent: 'EtherPK', before: '«- »a', text: 'x\ny', after: '- x\n- y|a' },
        { rule: 'on a continuation after the block’s children the next block is the owner’s sibling', precedent: 'EtherPK', before: '- a\n  - b\n  trailing|', text: 'one\ntwo', after: '- a\n  - b\n  trailingone\n- two|' },
        { rule: 'a copied tree pastes as itself on an empty bullet', precedent: 'Logseq', before: '- |', text: '- x\n  - y\n- z', after: '- x\n  - y\n- z|' },
        { rule: 'a paste over selected blocks replaces them with blocks', precedent: 'Logseq', before: '«- a\n- b»\n- c', text: 'x\ny', after: '- x\n- y|\n- c' },
        { rule: 'a foreign-grid fragment is put on the Indent Unit grid first (ADR 0067)', precedent: 'EtherPK', before: '- a|', text: '\n- x\n    - y\n        - z', after: '- a\n  - x\n    - y\n      - z|' },
        // What stays attached to a pasted block: its soft lines and its fenced code.
        { rule: 'a pasted block’s continuation lines stay its own', precedent: 'EtherPK', before: '- |', text: '- x\n  soft\n  \n  more\n- y', after: '- x\n  soft\n  \n  more\n- y|' },
        { rule: 'a pasted block’s fenced code travels with it', precedent: 'EtherPK', before: '- |', text: '- x\n  ```\n  code\n  ```\n- y', after: '- x\n  ```\n  code\n  ```\n- y|' },
        { rule: 'a fenced block owned by no bullet is one block of its own', precedent: 'EtherPK', before: '- |', text: 'Install\n```\nnpm i\n```\nRun', after: '- Install\n- ```\n  npm i\n  ```\n- Run|' },
        { rule: 'a fence pasted onto an empty bullet is the bullet’s own fence', precedent: 'EtherPK', before: '- |', text: '```\ncode\n```', after: '- ```\n  code\n  ```|' },
        { rule: 'a fence pasted after a block’s text starts on its own line inside the block', precedent: 'EtherPK', before: '- a|', text: '```\ncode\n```', after: '- a\n  ```\n  code\n  ```|' },
        { rule: 'text after the caret takes a soft line of its own after a pasted fence, never the closer’s info string', precedent: 'EtherPK', before: '- a|b', text: '```\ncode\n```', after: '- a\n  ```\n  code\n  ```\n  |b' },
        { rule: 'the same after a pasted block’s own fence', precedent: 'EtherPK', before: '- a|b', text: 'x\n- y\n  ```\n  code\n  ```', after: '- ax\n  - y\n    ```\n    code\n    ```\n    |b' },
    ]
    for (const row of rows) {
        it(`${row.rule} (${row.precedent})`, () => {
            expect(paste(row.before, row.text)).toBe(row.after)
        })
    }

    it('runs before the fence guard, so a pasted fence line does not stop the split', () => {
        // The guard corrects the block a pasted fence opens; if it ran first, the paste would arrive here
        // as a multi-change transaction and be left unsplit (the filter order in cm-document.ts).
        expect(paste('- |a\n  ```\n  ```', '\n    - \n```\n')).toBe('- \n  - \n- ```|a\n  ```\n  ```')
    })

    it('a single line over a margin drag that leaves content is typed text, as typing it would be', () => {
        expect(paste('«- »a', 'x')).toBe('x|a')
    })

    it('applies to a text drop onto a bullet as well as a paste', () => {
        expect(paste('- a|', 'one\n- two', 'input.drop')).toBe('- aone\n  - two|')
    })

    it('is one undo step, caret restored', () => {
        const editor = editorFixture('- a|\n- b')
        editor.paste('one\n- two\nthree')
        expect(editor.fixture()).toBe('- aone\n  - two\n- three|\n- b')
        editor.key('Mod-z')
        expect(editor.fixture()).toBe('- a|\n- b')
    })
})
