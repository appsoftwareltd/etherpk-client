/**
 * Property tests over the outliner keyboard layer: the invariants that must hold after *any*
 * sequence of structural keys on *any* well-formed outline, not just the rows in the rule tables.
 *
 * The rule tables (`outliner-keymap.rules.test.ts`) pin the documented behaviours one at a time.
 * These tests hunt the products of features the tables cannot enumerate: a Tab after a move after
 * a merge, on an outline with tasks, continuations and fences in it. Each invariant is a sentence
 * from Editor Content Rules.md.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { fencedBlocks } from '../fenced-code'
import { normaliseIndentUnit, outlineLines } from '../indent-unit'
import { isBulletLine, lineIndent, markerLength, opaqueLineFlags, parentIndex } from '../outliner'
import { clampColumn } from './caret-clamp'
import { editorFixture, type HeadlessEditor } from './testing/editor-state-fixture'

const INDENT = 2

/**
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `EDITOR_FUZZ_SEED=<n>` (any integer) and optionally `EDITOR_FUZZ_RUNS=<n>`; a failure prints the
 * seed and path that reproduce it, which then belongs in the rules test as a row.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return {
        numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs),
        seed: seed === undefined ? 20260902 : Number(seed),
    }
}

// ── Generators ───────────────────────────────────────────────────────────────────────────────

interface Bullet {
    /** Nesting level; the generator keeps every level within one of the previous bullet's. */
    level: number
    task: 'none' | 'open' | 'done'
    text: string
    continuation: string | null
    fence: string[] | null
    /** A continuation after the fence: the multi-line body the split and breakout paths travel over. */
    trailing: string | null
}

const word = fc.stringMatching(/^[a-z]{1,6}$/)

const bulletArb: fc.Arbitrary<Omit<Bullet, 'level'> & { step: -2 | -1 | 0 | 1 }> = fc.record({
    step: fc.constantFrom(-2, -1, 0, 1) as fc.Arbitrary<-2 | -1 | 0 | 1>,
    task: fc.constantFrom('none', 'open', 'done') as fc.Arbitrary<Bullet['task']>,
    text: word,
    continuation: fc.option(word, { nil: null }),
    // Code that looks like structure (a comment, a list, a blank) must stay opaque inside the fence.
    fence: fc.option(fc.array(fc.oneof(word, fc.constantFrom('# c', '- x', '', '  - y')), { minLength: 0, maxLength: 3 }), { nil: null }),
    trailing: fc.option(word, { nil: null }),
})

/** A well-formed outliner group: no bullet more than one level below its predecessor. */
const outlineArb: fc.Arbitrary<Bullet[]> = fc.array(bulletArb, { minLength: 1, maxLength: 7 }).map((rows) => {
    let level = 0
    return rows.map((row, i) => {
        level = i === 0 ? 0 : Math.max(0, Math.min(level + 1, level + row.step))
        return { level, task: row.task, text: row.text, continuation: row.continuation, fence: row.fence, trailing: row.trailing }
    })
})

/** A grid to render an outline on: the Indent Unit, or a foreign one — four spaces or a tab a level, or
 *  a ragged four-space grid where each bullet carries its own extra columns (over-nesting; siblings at
 *  different indents; a sibling as deep as the previous sibling's child). */
type Grid = 'unit' | 'four' | 'tab' | 'ragged'

/** Extra columns past the grid, one per bullet, for the ragged grid: over-nesting, or a sibling deeper than
 *  its sibling. Generated beside the outline (not inside it) so the unit-grid stream under the CI seed is
 *  the one it has always been. */
const extrasArb = fc.array(fc.constantFrom(0, 2, 4), { minLength: 7, maxLength: 7 })

/** A paragraph after a bullet's children, one per bullet (used when the bullet has children): the shape
 *  CommonMark and other tools write, which no key here makes (ADR 0089). Generated beside the outline
 *  like the extras, so the stream under the CI seed is unchanged for the other properties. */
const afterChildrenArb = fc.array(fc.option(word, { nil: null }), { minLength: 7, maxLength: 7 })

function render(outline: Bullet[], grid: Grid = 'unit', extras: number[] = [], afterChildren: (string | null)[] = []): string {
    const lines: string[] = []
    const step = grid === 'tab' ? '\t' : ' '.repeat(grid === 'four' || grid === 'ragged' ? 4 : INDENT)
    /** Paragraphs waiting for their block's subtree to close, innermost last. */
    const pending: { level: number; line: string }[] = []
    const closeTo = (level: number) => {
        while (pending.length && pending[pending.length - 1].level >= level) lines.push(pending.pop()!.line)
    }
    for (const [n, b] of outline.entries()) {
        closeTo(b.level)
        const indent = step.repeat(b.level) + (grid === 'ragged' && b.level > 0 ? ' '.repeat(extras[n] ?? 0) : '')
        const marker = b.task === 'none' ? '- ' : b.task === 'open' ? '- [ ] ' : '- [x] '
        lines.push(`${indent}${marker}${b.text}`)
        // The content column is indent + the fixed marker width (ADR 0020), for tasks too - a
        // continuation typed with Shift+Enter lands there, not after the checkbox.
        const column = indent + '  '
        if (b.continuation !== null) lines.push(`${column}${b.continuation}`)
        if (b.fence !== null) lines.push(`${column}\`\`\``, ...b.fence.map((l) => `${column}${l}`), `${column}\`\`\``)
        if (b.trailing !== null) lines.push(`${column}${b.trailing}`)
        const paragraph = afterChildren[n] ?? null
        if (paragraph !== null && (outline[n + 1]?.level ?? 0) > b.level) pending.push({ level: b.level, line: `${column}${paragraph}` })
    }
    closeTo(0)
    return lines.join('\n')
}

const STRUCTURAL_KEYS = ['Tab', 'Shift-Tab', 'Alt-ArrowUp', 'Alt-ArrowDown', 'Enter', 'Shift-Enter', 'Mod-Enter', 'Mod-Shift-Enter', 'Backspace', 'Delete']

const scenarioArb = fc.record({
    outline: outlineArb,
    /** Where the caret starts, as a fraction of the document. */
    caretAt: fc.double({ min: 0, max: 1, noNaN: true }),
    /** Sometimes a selection instead: from the caret's line to this far down, as a fraction of the rest. */
    selectTo: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
    keys: fc.array(fc.constantFrom(...STRUCTURAL_KEYS), { minLength: 1, maxLength: 6 }),
})

function editorFor(outline: Bullet[], caretAt: number, selectTo?: number, grid: Grid = 'unit', extras: number[] = [], afterChildren: (string | null)[] = []): HeadlessEditor {
    const doc = render(outline, grid, extras, afterChildren)
    const pos = Math.round(caretAt * doc.length)
    const editor = editorFixture(doc.slice(0, pos) + '|' + doc.slice(pos))
    // Re-place the caret through a selection transaction so the caret clamp applies, exactly as a
    // click would; the fixture's initial selection bypasses transaction filters.
    editor.select(pos)
    if (selectTo !== undefined) {
        // A drag from the caret down the document, through the same transaction a mouse drag makes:
        // reaching a second block, the block-selection filter snaps it to whole blocks, so Tab, Shift-Tab
        // and the deleting keys see a block selection; inside one block, and in prose, it stays a text range.
        const head = pos + Math.round(selectTo * (doc.length - pos))
        editor.select(pos, head)
    }
    return editor
}

// ── Invariants ───────────────────────────────────────────────────────────────────────────────

/** No bullet sits more than one nesting level below the bullet before it in its group, and a group's
 *  first bullet sits at the top level: an indented bullet after a blank line has no parent either
 *  (the shape Backspace on an empty top bullet with children used to leave). Groups are bounded by
 *  bare empty lines outside fences — a fence's own blank line is code (indent decides blankness
 *  elsewhere: a whitespace-only line is inside a block) — and fenced interiors are skipped, so a
 *  `- x` line in a code block is never read as a bullet. A form-1 opener (`- \`\`\``) is a bullet. */
function noOrphans(lines: string[], proseAsNode = false): boolean {
    const blocks = fencedBlocks(lines)
    const interior = (i: number) => blocks.some((b) => i > b.start && i <= b.end)
    let previous: number | null = null
    lines.forEach((line, i) => {
        if (interior(i)) return
        if (line.length === 0) {
            previous = null // a bare empty line bounds the group
            return
        }
        // A prose line between bullets is measured across: Ctrl+Enter exits after the whole tree, so
        // no key may leave the bullets after a prose line without their parent. The normaliser (like
        // `healOrphanIndent`) reads a plain line as a node a bullet may sit one unit under; the
        // foreign-grid test judges its output that way.
        if (!isBulletLine(line)) {
            if (proseAsNode && line.trim() !== '') previous = lineIndent(line)
            return
        }
        const indent = lineIndent(line)
        if (indent > (previous ?? -INDENT) + INDENT) throw new Error(`orphan at line ${i}: ${JSON.stringify(lines)}`)
        previous = indent
    })
    return true
}

/** Every bullet indent is a whole number of nesting units. */
function indentsOnGrid(lines: string[]): boolean {
    return lines.every((line) => !isBulletLine(line) || lineIndent(line) % INDENT === 0)
}

/** Every fenced block that was complete is still complete: openers and closers stay paired. */
function fencesBalanced(lines: string[]): number {
    return fencedBlocks(lines).length
}

/** Backspace or Delete with the caret inside a fence line's own text (right of the fence column). */
function editsFenceText(editor: HeadlessEditor, key: string): boolean {
    const { state } = editor
    const sel = state.selection.main
    const lines = editor.text().split('\n')
    if (!sel.empty) {
        // The deleting keys, and the keys whose default replaces a selection (Enter, Mod-Enter), remove
        // a selected fence line by the user's own hand: the block is dissolved on purpose, like editing
        // the fence's own characters.
        if (!['Backspace', 'Delete', 'Enter', 'Mod-Enter'].includes(key)) return false
        const first = state.doc.lineAt(sel.from).number - 1
        const last = state.doc.lineAt(sel.to).number - 1
        return fencedBlocks(lines).some((b) => (b.start >= first && b.start <= last) || (b.end >= first && b.end <= last))
    }
    if (key !== 'Backspace' && key !== 'Delete') return false
    const line = state.doc.lineAt(sel.head)
    const onFence = fencedBlocks(lines).some((b) => line.number - 1 === b.start || line.number - 1 === b.end)
    const margin = lineIndent(line.text) + (isBulletLine(line.text) ? markerLength(line.text) : 0)
    // Backspace right of the margin removes a fence character; Delete at the margin removes the first one.
    return onFence && (key === 'Delete' ? sel.head - line.from >= margin : sel.head - line.from > margin)
}

/**
 * The keymap and the walk read one tree: for every bullet, the parent the keymap's primitives find
 * (`parentIndex`, the nearest shallower bullet within the group) is the parent the outline walk gives
 * the clamp and the block model (the nearest earlier line one depth up, owned by a bullet). This is the
 * ADR 0067 claim — import, index, rendering and keys can never disagree — checked on every grid.
 */
function keysAndWalkAgree(lines: string[]): boolean {
    const blocks = fencedBlocks(lines)
    const opaque = opaqueLineFlags(lines, blocks)
    const outline = outlineLines(lines, blocks)
    lines.forEach((line, i) => {
        if (opaque[i] && !blocks.some((b) => b.start === i) || !isBulletLine(line)) return
        const d = outline[i].depth
        let walkParent: number | null = null
        for (let j = i - 1; j >= 0 && d > 0; j--) {
            if (lines[j].length === 0 && !opaque[j]) break // a bare empty line bounds the group
            if (outline[j].depth < d) {
                walkParent = outline[j].owner >= 0 ? outline[j].owner : null
                break
            }
        }
        const keyParent = parentIndex(lines, i, blocks)
        if (keyParent !== walkParent) throw new Error(`line ${i}: keymap parent ${keyParent}, walk parent ${walkParent}: ${JSON.stringify(lines)}`)
    })
    return true
}

/** A bullet's own line never loses its marker to a partial edit (`-` without the space). A line inside a
 *  fence is code: a `- x` there edited down to `-` is not a marker (seed 1 used to flag it). */
function markersIntact(lines: string[]): boolean {
    const blocks = fencedBlocks(lines)
    return lines.every((line, i) => blocks.some((f) => i > f.start && i <= f.end) || !/^\s*-(\[|$)/.test(line))
}

describe('outliner invariants under random key sequences', () => {
    it('never creates an orphan, never leaves a bullet off the indent grid, never breaks a marker', () => {
        fc.assert(
            fc.property(scenarioArb, ({ outline, caretAt, selectTo, keys }) => {
                const editor = editorFor(outline, caretAt, selectTo)
                for (const key of keys) {
                    // Deleting a fence's own characters dissolves the block on purpose, and the code it held
                    // (a `- y` line, say) becomes outline text the user now owns; stop judging the sequence.
                    if (editsFenceText(editor, key)) return
                    editor.key(key)
                    const lines = editor.text().split('\n')
                    expect(noOrphans(lines)).toBe(true)
                    expect(indentsOnGrid(lines)).toBe(true)
                    expect(markersIntact(lines)).toBe(true)
                    expect(keysAndWalkAgree(lines)).toBe(true)
                    // Text the editor writes is already on the Indent Unit grid: the normaliser an import
                    // runs is the identity on it (ADR 0067), fences, soft lines and tasks included.
                    expect(normaliseIndentUnit(editor.text())).toBe(editor.text())
                }
            }),
            fuzz(400),
        )
    })

    it('with a paragraph after a sublist (a shape other tools write) every key keeps the invariants', () => {
        // The line sits at the parent's content column below the parent's children and is the parent's
        // (ADR 0089): Enter there opens the parent's next sibling, the joins read it as the parent's, and
        // the tidy trims it with the block. Nothing here makes the shape, so it is generated beside the
        // outline and driven through the same keys as the plain stream.
        fc.assert(
            fc.property(scenarioArb, afterChildrenArb, ({ outline, caretAt, selectTo, keys }, afterChildren) => {
                const editor = editorFor(outline, caretAt, selectTo, 'unit', [], afterChildren)
                for (const key of keys) {
                    if (editsFenceText(editor, key)) return
                    editor.key(key)
                    const lines = editor.text().split('\n')
                    expect(noOrphans(lines)).toBe(true)
                    expect(indentsOnGrid(lines)).toBe(true)
                    expect(markersIntact(lines)).toBe(true)
                    expect(keysAndWalkAgree(lines)).toBe(true)
                    expect(normaliseIndentUnit(editor.text())).toBe(editor.text())
                }
            }),
            fuzz(300),
        )
    })

    it('on foreign-grid text (four spaces, tabs, ragged) every key keeps the tree readable and re-griddable', () => {
        // A file from a four-space vault, a tab-indented Logseq page or a hand-edited over-nested list is
        // read structurally and never re-gridded on open (ADR 0067). The keys must still work on it: no
        // marker breaks, no fence dissolves, the keymap and the walk keep reading one tree, and after
        // every key the document normalises to a well-formed two-space outline with the same structural
        // depths it had before normalising - the normaliser only moves lines.
        const foreignArb = fc.record({ scenario: scenarioArb, grid: fc.constantFrom('four', 'tab', 'ragged') as fc.Arbitrary<Grid>, extras: extrasArb })
        fc.assert(
            fc.property(foreignArb, ({ scenario: { outline, caretAt, selectTo, keys }, grid, extras }) => {
                const editor = editorFor(outline, caretAt, selectTo, grid, extras)
                expect(keysAndWalkAgree(editor.text().split('\n'))).toBe(true)
                for (const key of keys) {
                    if (editsFenceText(editor, key)) return
                    editor.key(key)
                    const lines = editor.text().split('\n')
                    expect(markersIntact(lines)).toBe(true)
                    expect(keysAndWalkAgree(lines)).toBe(true)
                    // The editor measures characters and the boundary columns (indent-unit.ts, module
                    // comment); the two readings coincide on space-only text. Once a key has written spaces
                    // beside tabs the file is mixed, and the boundary may legitimately read a different tree
                    // (even different fences) from the one the editor showed — the documented limit of
                    // tab-indented files, so the normaliser's output is judged on the space grids only.
                    if (grid === 'tab') continue
                    const normal = normaliseIndentUnit(editor.text())
                    const normalLines = normal.split('\n')
                    expect(noOrphans(normalLines, true)).toBe(true)
                    expect(indentsOnGrid(normalLines)).toBe(true)
                    expect(normaliseIndentUnit(normal)).toBe(normal)
                    expect(outlineLines(normalLines).map((l) => l.depth)).toEqual(outlineLines(lines).map((l) => l.depth))
                }
            }),
            fuzz(300),
        )
    })

    it('never dissolves a fenced block: Enter may complete one, no structural key breaks one', () => {
        // A fence is opaque to movement and indentation, and the joining keys are consumed at its
        // edges, so the count of complete blocks can only grow (Enter completing an opener).
        fc.assert(
            fc.property(scenarioArb, ({ outline, caretAt, selectTo, keys }) => {
                const editor = editorFor(outline, caretAt, selectTo)
                let count = fencesBalanced(editor.text().split('\n'))
                for (const key of keys) {
                    const editsFence = editsFenceText(editor, key)
                    editor.key(key)
                    const next = fencesBalanced(editor.text().split('\n'))
                    // Deleting a fence's own characters is how a block is dissolved on purpose.
                    if (!editsFence) expect(next).toBeGreaterThanOrEqual(count)
                    count = next
                }
            }),
            fuzz(400),
        )
    })

    it('never rests the caret left of the content column after a structural key', () => {
        fc.assert(
            fc.property(scenarioArb, ({ outline, caretAt, selectTo, keys }) => {
                const editor = editorFor(outline, caretAt, selectTo)
                for (const key of keys) {
                    editor.key(key)
                    const sel = editor.state.selection.main
                    if (!sel.empty) continue
                    const lines = editor.text().split('\n')
                    const line = editor.state.doc.lineAt(sel.head)
                    const column = sel.head - line.from
                    expect(column).toBeGreaterThanOrEqual(clampColumn(lines, line.number - 1))
                }
            }),
            fuzz(300),
        )
    })

    it('a multi-line paste never dissolves a fenced block or creates an orphan', () => {
        // Code-shaped fragments (links, words) and outline fragments at grid indents, a bullet as the
        // first line included: it merges into the target line and its descendants hang from there (ADR
        // 0089). A pasted fence line is out of scope: it opens or closes a block by the user's own hand,
        // and what that does to the lines around it is the text's truth, not the clamp's business.
        const fragment = fc
            .array(fc.stringMatching(/^( {2}){0,2}(http:\/\/|- )?[a-z]{0,5}$/), { minLength: 2, maxLength: 4 })
            .map((l) => l.join('\n'))
        fc.assert(
            fc.property(outlineArb, fc.double({ min: 0, max: 1, noNaN: true }), fragment, (outline, caretAt, text) => {
                const editor = editorFor(outline, caretAt)
                const lines = editor.text().split('\n')
                const line = editor.state.doc.lineAt(editor.head())
                // Inside a fence, or on a bullet or continuation line: the clamp is live. A caret on a fence
                // line itself is editing the fence, which may dissolve the block on purpose.
                if (clampColumn(lines, line.number - 1) === 0) return
                if (fencedBlocks(lines).some((b) => line.number - 1 === b.start || line.number - 1 === b.end)) return
                const fences = fencesBalanced(lines)
                editor.paste(text)
                const after = editor.text().split('\n')
                expect(fencesBalanced(after)).toBeGreaterThanOrEqual(fences)
                expect(noOrphans(after)).toBe(true)
            }),
            fuzz(300),
        )
    })

    it('Mod-z restores the exact text and caret after any single structural key', () => {
        fc.assert(
            fc.property(scenarioArb, ({ outline, caretAt, selectTo, keys }) => {
                const editor = editorFor(outline, caretAt, selectTo)
                const before = editor.fixture()
                const handled = editor.key(keys[0])
                if (!handled || editor.text() === before.replace('|', '')) return
                editor.key('Mod-z')
                expect(editor.fixture()).toBe(before)
            }),
            fuzz(300),
        )
    })

    it('a bullet line always has its marker at the indent, so markerLength stays well-defined', () => {
        fc.assert(
            fc.property(scenarioArb, ({ outline, caretAt, selectTo, keys }) => {
                const editor = editorFor(outline, caretAt, selectTo)
                for (const key of keys) {
                    editor.key(key)
                    for (const line of editor.text().split('\n')) {
                        if (!isBulletLine(line)) continue
                        expect(line.slice(lineIndent(line), lineIndent(line) + markerLength(line))).toMatch(/^- (\[[ x]\] )?$/)
                    }
                }
            }),
            fuzz(200),
        )
    })
})
