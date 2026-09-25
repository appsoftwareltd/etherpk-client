/**
 * The Indent Unit (ADR 0067): the normaliser that puts foreign text on the two-space grid, and the
 * structural per-line depth the editor and the block model read. Each case is a sentence from
 * Editor Content Rules → *The Indent Unit*.
 */

import { describe, expect, it } from 'vitest'

import { indentColumns, normaliseIndentUnit, outlineLines } from './indent-unit'

const L = (s: string) => s.split('\n')

describe('indentColumns', () => {
    it('counts spaces, and a tab advances to the next multiple of four', () => {
        expect(indentColumns('- a')).toBe(0)
        expect(indentColumns('   - a')).toBe(3)
        expect(indentColumns('\t- a')).toBe(4)
        expect(indentColumns('  \t- a')).toBe(4)
        expect(indentColumns('\t\t- a')).toBe(8)
        expect(indentColumns('\t  - a')).toBe(6)
    })
})

describe('normaliseIndentUnit', () => {
    it('returns a document already on the grid byte-identical (same reference)', () => {
        const text = '- a\n  - b\n    - c\n  - d\n- e'
        expect(normaliseIndentUnit(text)).toBe(text)
    })

    it('re-grids a four-space tree to two spaces per level', () => {
        expect(normaliseIndentUnit('- a\n    - b\n        - c\n    - d')).toBe('- a\n  - b\n    - c\n  - d')
    })

    it('re-grids a tab-indented tree (Logseq) to two spaces per level', () => {
        expect(normaliseIndentUnit('- a\n\t- b\n\t\t- c\n- d')).toBe('- a\n  - b\n    - c\n- d')
    })

    it('a deeper bullet is a child, an equal one a sibling: over-nesting collapses to one unit', () => {
        expect(normaliseIndentUnit('- a\n      - b\n    - c\n      - d')).toBe('- a\n  - b\n  - c\n    - d')
    })

    it('a top-level bullet lands at column 0 even when the whole list was indented', () => {
        expect(normaliseIndentUnit('    - a\n        - b')).toBe('- a\n  - b')
    })

    it('a continuation line moves with its bullet and keeps its indentation beyond the content column', () => {
        expect(normaliseIndentUnit('- a\n    - b\n      soft\n          deeper')).toBe('- a\n  - b\n    soft\n        deeper')
    })

    it('an indented soft line moves with its block; a flush-left empty line stays', () => {
        expect(normaliseIndentUnit('- a\n    - b\n      \n\n- c')).toBe('- a\n  - b\n    \n\n- c')
    })

    it('a fenced block under a bullet moves as a unit, its code untouched beyond the shift', () => {
        expect(normaliseIndentUnit('- a\n    - b\n      ```ts\n      const x = 1\n        indented()\n      ```\n    - c')).toBe(
            '- a\n  - b\n    ```ts\n    const x = 1\n      indented()\n    ```\n  - c',
        )
    })

    it('a form-1 fence bullet (`- ```) carries its fence lines with it', () => {
        expect(normaliseIndentUnit('- a\n    - ```\n      code\n      ```\n    - c')).toBe('- a\n  - ```\n    code\n    ```\n  - c')
    })

    it('a bullet-looking line inside a fenced block is code, not a node', () => {
        // The fence sits past its owner's content column: the excess is kept (a fenced block is
        // content), and only the real bullet after it is re-gridded.
        expect(normaliseIndentUnit('- a\n    ```\n    - not a bullet\n        - nor this\n    ```\n    - b')).toBe(
            '- a\n    ```\n    - not a bullet\n        - nor this\n    ```\n  - b',
        )
        expect(normaliseIndentUnit('    - a\n      ```\n      - not a bullet\n      ```')).toBe('- a\n  ```\n  - not a bullet\n  ```')
    })

    it('a tab in the code past the fence column stays a tab when the block moves', () => {
        // The bullet and fence lines shift by -4; only the six columns up to the fence are rewritten.
        expect(normaliseIndentUnit('    - a\n      ```\n      \tcode\n      ```')).toBe('- a\n  ```\n  \tcode\n  ```')
    })

    it('a tab-indented fence (Logseq code in a bullet) has its structural tabs put in spaces so the fences stay paired', () => {
        expect(normaliseIndentUnit('- a\n\t```\n\t\tcode\n\t```')).toBe('- a\n    ```\n    \tcode\n    ```')
    })

    it('a tab-indented code line inside a fence that does not move keeps its tab', () => {
        const text = '- a\n  ```\n  \tcode\n  ```'
        expect(normaliseIndentUnit(text)).toBe(text)
    })

    it('top-level prose, headings and an indented code block outside a list keep their indent', () => {
        const text = '# Title\n\nSome prose.\n\n    indented code block\n\n  two-space prose'
        expect(normaliseIndentUnit(text)).toBe(text)
    })

    it('a tab in top-level prose becomes its columns (CommonMark reads it as four)', () => {
        expect(normaliseIndentUnit('\tcode')).toBe('    code')
    })

    it('frontmatter is never touched, YAML lists and tabs included', () => {
        const text = '---\ntitle: x\ntags:\n    - a\n\t- b\n---\n- c\n    - d'
        expect(normaliseIndentUnit(text)).toBe('---\ntitle: x\ntags:\n    - a\n\t- b\n---\n- c\n  - d')
    })

    it('a bullet under an indented prose line stays one unit under it', () => {
        expect(normaliseIndentUnit('    prose\n            - a')).toBe('    prose\n      - a')
        expect(normaliseIndentUnit('prose\n    - a\n        - b')).toBe('prose\n  - a\n    - b')
    })

    it('a task is a bullet', () => {
        expect(normaliseIndentUnit('- [ ] a\n    - [x] b')).toBe('- [ ] a\n  - [x] b')
    })

    it('a group after a blank line starts from the top level again', () => {
        expect(normaliseIndentUnit('- a\n    - b\n\n    - c\n        - d')).toBe('- a\n  - b\n\n- c\n  - d')
    })

    it('is idempotent on what it produces', () => {
        for (const text of [
            '- a\n\t- b\n\t\t- c',
            '- a\n      - b\n    - c\n      soft',
            'prose\n    - a\n        - b\n\n    - c',
            '- a\n    ```\n    - x\n    ```\n    - b',
        ]) {
            const once = normaliseIndentUnit(text)
            expect(normaliseIndentUnit(once)).toBe(once)
        }
    })
})

describe('outlineLines', () => {
    it('gives each bullet its structural depth, whatever grid it is on', () => {
        expect(outlineLines(L('- a\n  - b\n    - c')).map((l) => l.depth)).toEqual([0, 1, 2])
        expect(outlineLines(L('- a\n    - b\n        - c')).map((l) => l.depth)).toEqual([0, 1, 2])
        expect(outlineLines(L('- a\n\t- b\n\t\t- c')).map((l) => l.depth)).toEqual([0, 1, 2])
        expect(outlineLines(L('- a\n      - b\n    - c')).map((l) => l.depth)).toEqual([0, 1, 1])
    })

    it('measures characters, as the editor does: a tab is one, so a space-indented line beside a tabbed one reads by count', () => {
        // The boundary measures columns (a tab is four); inside the editor every reader counts
        // characters, and the walk that serves the editor must agree with them.
        expect(outlineLines(L('- a\n\t- b\n  \t- c')).map((l) => l.depth)).toEqual([0, 1, 2])
        expect(outlineLines(L('- a\n\t- b\n \t- c\n\t- d')).map((l) => l.depth)).toEqual([0, 1, 2, 1])
    })

    it('a bare empty line closes every open branch: an indented bullet after one has no parent', () => {
        expect(outlineLines(L('- a\n\n  - b')).map((l) => ({ ...l }))).toEqual([
            { depth: 0, owner: 0 },
            { depth: 0, owner: -1 },
            { depth: 0, owner: 2 },
        ])
    })

    it('a bullet owns itself, its continuation lines, its soft lines and its fenced block', () => {
        const lines = L('- a\n  soft\n  \n  ```\n  - x\n  ```\n  - b\n\n- c')
        expect(outlineLines(lines).map((l) => l.owner)).toEqual([0, 0, 0, 0, 0, 0, 6, -1, 8])
        expect(outlineLines(lines).map((l) => l.depth)).toEqual([0, 0, 0, 0, 0, 0, 1, 0, 0])
    })

    it('a plain line nests under a deeper plain line; a bullet under prose is one deeper', () => {
        expect(outlineLines(L('a\n  b\n    c')).map((l) => l.depth)).toEqual([0, 1, 2])
        expect(outlineLines(L('title\n  - a')).map((l) => ({ ...l }))).toEqual([
            { depth: 0, owner: -1 },
            { depth: 1, owner: 1 },
        ])
    })

    it('a shallower prose line closes the branch; frontmatter is outside the outline', () => {
        expect(outlineLines(L('---\nt: x\n---\n- a\n  - b\nprose\n  - c')).map((l) => l.depth)).toEqual([0, 0, 0, 0, 1, 0, 1])
        expect(outlineLines(L('---\nt: x\n---\n- a\n  - b\nprose\n  - c')).map((l) => l.owner)).toEqual([-1, -1, -1, 3, 4, -1, 6])
    })

    it('top-level code is owned by nothing', () => {
        expect(outlineLines(L('```\n- x\n```\n- a')).map((l) => l.owner)).toEqual([-1, -1, -1, 3])
    })
})
