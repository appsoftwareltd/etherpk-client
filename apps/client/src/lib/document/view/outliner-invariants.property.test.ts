/**
 * Property tests over the outliner keyboard layer: the invariants that must hold after *any*
 * sequence of structural keys on *any* well-formed outline, not just the rows in the rule tables.
 *
 * The rule tables (`outliner-keymap.rules.test.ts`) pin the documented behaviours one at a time.
 * These tests hunt the products of features the tables cannot enumerate: a Tab after a move after
 * a merge, on an outline with tasks, continuations and fences in it. Each invariant is a sentence
 * from Editor Content Rules.md.
 */

import { keymap } from '@codemirror/view'
import fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createContributionRegistry, setActiveContributionRegistry } from '$lib/surface'

import { frontmatterLines } from '$lib/storage/fs/frontmatter-span'

import { fencedBlocks, fenceLineInfo } from '../fenced-code'
import { normaliseIndentUnit, outlineLines } from '../indent-unit'
import { bulletContent, contentStart, formOneOpeners, isBulletLine, lineIndent, markerLength, opaqueLineFlags, parentIndex } from '../outliner'
import { analysisFor } from './analysis/editor-analysis'
import { interactiveFenceAugmentation } from './augmentations/interactive-fence'
import { type InteractiveFence, registerInteractiveFence } from './augmentations/interactive-fence-contract'
import { collapsedInteractiveFences, interactiveFences } from './augmentations/interactive-fence-state'
import { clampColumn } from './caret-clamp'
import { toggleBullet } from './outliner-keymap'
import { bulletToggleable } from './task-toggleable'
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

/** Whether each bullet's fence carries empty lines, without the fence column's spaces: its own blank
 *  lines written empty, and one more at the top of its body. That is how other tools and agents write
 *  them, where the editor's own keys always indent them. Beside the outline, like the extras. */
const bareBlanksArb = fc.array(fc.boolean(), { minLength: 7, maxLength: 7 })

/** Where each plain bullet with a fence opens it: below the bullet's text (form 2), or on the bullet
 *  line (form 1, `- \`\`\``), as Logseq writes a code block that is a block's whole content - bare, with an
 *  info string, or with nothing after its closer. When something follows the closer, the bullet's text
 *  is a soft line there and its trailing line sits deeper still, where the outline walk gives it to
 *  the bullet across the closer. Beside the outline, like the extras. */
type FenceForm = 'below' | 'on' | 'on-info' | 'on-bare'
const formOneArb = fc.array(fc.constantFrom<FenceForm>('below', 'on', 'on-info', 'on-bare'), { minLength: 7, maxLength: 7 })

/** Frontmatter above the outline: none, plain YAML with a list, or YAML holding a bullet-shaped fence
 *  in a (folded) block scalar, which is text and never a bullet the body could nest under. The `>`
 *  scalar, not `|`, since `|` is the fixture's caret marker. */
const frontmatterArb = fc.constantFrom<string[]>([], ['---', 'title: T', 'tags:', '  - x', '---'], ['---', 'snippet: >', '  - ```js', '    x', '    ```', '---'])

/** Bullet text that is a `---`, one per bullet, in place of the word on a bullet with no code block of
 *  its own: leaving the list takes it to the margin, where it can close a frontmatter block. Beside the
 *  outline, like the extras. */
const ruleTextArb = fc.array(fc.option(fc.constant('---'), { nil: null }), { minLength: 7, maxLength: 7 })

/** The same with fence text too, which at the margin pairs with another fence there. Only the check of
 *  leaving the list uses it: Delete at the end of a bullet whose text is an unterminated fence joins the
 *  next bullet's text onto it, and the joined opener takes the next block's opening fence for its
 *  closer, a gap of the joins, not of leaving the list. */
const edgeTextArb = fc.array(fc.option(fc.constantFrom('```', '```py', '---'), { nil: null }), { minLength: 7, maxLength: 7 })

/** Text at the margin around the outline that a bullet's text could pair with once its marker goes: an
 *  unclosed `---` with a key under it or a closed frontmatter block above, a rule below. Beside the
 *  outline, like the extras. */
interface Margin {
    above: string[]
    below: string[]
}
/** The same with fences too: an unterminated prose fence above, a prose code block below. An open fence
 *  above with a fence below makes the whole outline the code of one prose block, its own blocks nested in
 *  it. A prose code block directly under a bullet ends its group, which Tab once nested across. */
const marginArb: fc.Arbitrary<Margin> = fc.record({
    above: fc.constantFrom<string[]>([], ['---', 'title: T'], ['---', 'title: T', '---'], ['```js', 'text']),
    below: fc.constantFrom<string[]>([], ['```', 'code', '```'], ['', '```', 'code', '```'], ['', '---', 'more']),
})

function render(outline: Bullet[], grid: Grid = 'unit', extras: number[] = [], afterChildren: (string | null)[] = [], bareBlanks: boolean[] = [], formOne: FenceForm[] = [], frontmatter: string[] = [], edgeText: (string | null)[] = [], margin: Margin = { above: [], below: [] }): string {
    const lines: string[] = [...frontmatter, ...margin.above]
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
        // A task's fence cannot open on its line: its backticks would sit past the content column, where
        // no closer at the column pairs with them.
        const form = formOne[n] ?? 'below'
        const onBulletLine = b.fence !== null && b.task === 'none' && form !== 'below'
        const text = b.fence === null ? (edgeText[n] ?? b.text) : b.text
        lines.push(onBulletLine ? `${indent}${marker}\`\`\`${form === 'on-info' ? 'py' : ''}` : `${indent}${marker}${text}`)
        // The content column is indent + the fixed marker width (ADR 0020), for tasks too - a
        // continuation typed with Shift+Enter lands there, not after the checkbox.
        const column = indent + '  '
        const body = b.fence === null ? [] : [...(bareBlanks[n] ? [''] : []), ...b.fence.map((l) => (l === '' && bareBlanks[n] ? '' : `${column}${l}`))]
        if (onBulletLine) {
            lines.push(...body, `${column}\`\`\``)
            if (form !== 'on-bare') {
                lines.push(`${column}${b.text}`)
                if (b.continuation !== null) lines.push(`${column}${b.continuation}`)
                if (b.trailing !== null) lines.push(`${column}  ${b.trailing}`)
            }
        } else {
            if (b.continuation !== null) lines.push(`${column}${b.continuation}`)
            if (b.fence !== null) lines.push(`${column}\`\`\``, ...body, `${column}\`\`\``)
            if (b.trailing !== null) lines.push(`${column}${b.trailing}`)
        }
        const paragraph = afterChildren[n] ?? null
        if (paragraph !== null && (outline[n + 1]?.level ?? 0) > b.level) pending.push({ level: b.level, line: `${column}${paragraph}` })
    }
    closeTo(0)
    lines.push(...margin.below)
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

function editorFor(outline: Bullet[], caretAt: number, selectTo?: number, grid: Grid = 'unit', extras: number[] = [], afterChildren: (string | null)[] = [], bareBlanks: boolean[] = [], formOne: FenceForm[] = [], frontmatter: string[] = [], edgeText: (string | null)[] = [], margin?: Margin): HeadlessEditor {
    const doc = render(outline, grid, extras, afterChildren, bareBlanks, formOne, frontmatter, edgeText, margin)
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
    const body = frontmatterLines(lines) // YAML is never outline
    let previous: number | null = null
    lines.forEach((line, i) => {
        if (i < body || interior(i)) return
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

/** Every bullet indent is a whole number of nesting units. A `- x` line inside a fence is code, whose
 *  own indentation is the user's: Delete or Tab inside it moves it by one space or two. */
function indentsOnGrid(lines: string[]): boolean {
    const blocks = fencedBlocks(lines)
    const body = frontmatterLines(lines) // a YAML list entry is metadata, on whatever grid its author chose
    return lines.every((line, i) => i < body || blocks.some((f) => i > f.start && i <= f.end) || !isBulletLine(line) || lineIndent(line) % INDENT === 0)
}

/** Every fenced block that was complete is still complete: openers and closers stay paired. A fence
 *  in the frontmatter is YAML text, which the keys edit as text. */
function fencesBalanced(lines: string[]): number {
    const body = frontmatterLines(lines)
    return fencedBlocks(lines).filter((b) => b.start >= body).length
}

/**
 * The code a document holds, as an oracle independent of the keymap's own guard (which compares which
 * lines are code, line by line through the change): each fenced block as its opener's info string and
 * the text of its code lines, sorted, so a block may move or re-indent but not pair differently, and the
 * frontmatter's text.
 */
function codeHeld(lines: string[]): string {
    const blocks = fencedBlocks(lines)
        .map((b) => [fenceLineInfo(lines[b.start])?.info ?? '', ...lines.slice(b.start + 1, b.end).map((l) => l.trim())].join('\n'))
        .sort()
    return [lines.slice(0, frontmatterLines(lines)).join('\n'), ...blocks].join('\u0000')
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
        if (!['Backspace', 'Delete', 'Mod-Backspace', 'Mod-Delete', 'Enter', 'Mod-Enter'].includes(key)) return false
        const first = state.doc.lineAt(sel.from).number - 1
        const last = state.doc.lineAt(sel.to).number - 1
        return fencedBlocks(lines).some((b) => (b.start >= first && b.start <= last) || (b.end >= first && b.end <= last))
    }
    // The word deletes take a fence's text from where the character deletes would take a character of it.
    const forward = key === 'Delete' || key === 'Mod-Delete'
    if (!forward && key !== 'Backspace' && key !== 'Mod-Backspace') return false
    const line = state.doc.lineAt(sel.head)
    const onFence = fencedBlocks(lines).some((b) => line.number - 1 === b.start || line.number - 1 === b.end)
    const margin = lineIndent(line.text) + (isBulletLine(line.text) ? markerLength(line.text) : 0)
    // Backspace right of the margin removes a fence character; Delete at the margin removes the first one.
    return onFence && (forward ? sel.head - line.from >= margin : sel.head - line.from > margin)
}

/** A deleting or splitting key on a rule (`---`, at the margin or as a bullet's text): an edit of the
 *  person's own dashes, as of a fence's own characters. Deleted down to, or split around, a lone `-`, a
 *  rule looks like a broken marker to the marker check, which judges bullets, not a person's text. */
function editsRule(editor: HeadlessEditor, key: string): boolean {
    if (!['Backspace', 'Delete', 'Enter', 'Shift-Enter', 'Mod-Enter'].includes(key)) return false
    const line = editor.state.doc.lineAt(editor.state.selection.main.head).text
    return /^-+$/.test(isBulletLine(line) ? bulletContent(line) : line.trim())
}

/** Move the caret to where Backspace or Delete joins two blocks rather than edits text: the start of a
 *  bullet's text for Backspace, the end of a bullet's line for Delete. False where the caret's line is
 *  not a bullet of the outline (code, YAML, prose), where neither key joins blocks. */
function placeForJoin(editor: HeadlessEditor, key: 'Backspace' | 'Delete'): boolean {
    const sel = editor.state.selection.main
    if (!sel.empty) return false
    const line = editor.state.doc.lineAt(sel.head)
    const lines = editor.text().split('\n')
    const blocks = fencedBlocks(lines)
    const n = line.number - 1
    if (!isBulletLine(line.text) || (opaqueLineFlags(lines, blocks)[n] && !formOneOpeners(lines, blocks).has(n))) return false
    editor.select(key === 'Backspace' ? line.from + contentStart(line.text) : line.to)
    return true
}

/** The selection starts inside the frontmatter: YAML editing, which may dissolve the block on purpose
 *  (a delimiter edited away), leaving its lines to the body as text the user now owns. */
function editsFrontmatter(editor: HeadlessEditor): boolean {
    const body = frontmatterLines(editor.text().split('\n'))
    return body > 0 && editor.state.doc.lineAt(editor.state.selection.main.from).number - 1 < body
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
    const body = frontmatterLines(lines)
    return lines.every((line, i) => i < body || blocks.some((f) => i > f.start && i <= f.end) || !/^\s*-(\[|$)/.test(line))
}

// Each property replays a fixed, seeded batch of a few hundred key sequences, so the work never
// varies but the time does: about half a second alone, and ten times that when `pnpm test` runs
// all four packages' suites at once (the pre-push `pnpm verify`). Vitest's 5 s default is a hang
// guard, which a busy machine trips on fixed work. A real hang still fails, at 30 s.
describe('outliner invariants under random key sequences', { timeout: 30_000 }, () => {
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

    it('with form-1 blocks (the fence on the bullet line) every key keeps the invariants', () => {
        // The lines after a form-1 block's closer are its bullet's, as after a form-2 block's: the keys
        // measure merges, splits and moves against that bullet. No fence dissolves unless the key edits
        // a fence's own characters, and the caret never rests left of its line's clamp.
        fc.assert(
            fc.property(scenarioArb, formOneArb, frontmatterArb, ({ outline, caretAt, selectTo, keys }, formOne, frontmatter) => {
                // The caret starts in the body. An edit before the opening delimiter moves the block off
                // the first line, where it stops being frontmatter: that edge is not this property's.
                const doc = render(outline, 'unit', [], [], [], formOne, frontmatter)
                const from = frontmatter.length ? frontmatter.join('\n').length + 1 : 0
                const editor = editorFor(outline, (from + caretAt * (doc.length - from)) / doc.length, selectTo, 'unit', [], [], [], formOne, frontmatter)
                let fences = fencesBalanced(editor.text().split('\n'))
                for (const key of keys) {
                    if (editsFenceText(editor, key) || editsFrontmatter(editor)) return
                    editor.key(key)
                    const lines = editor.text().split('\n')
                    expect(noOrphans(lines)).toBe(true)
                    expect(indentsOnGrid(lines)).toBe(true)
                    expect(markersIntact(lines)).toBe(true)
                    expect(keysAndWalkAgree(lines)).toBe(true)
                    expect(normaliseIndentUnit(editor.text())).toBe(editor.text())
                    const next = fencesBalanced(lines)
                    expect(next, key).toBeGreaterThanOrEqual(fences)
                    fences = next
                    const sel = editor.state.selection.main
                    if (!sel.empty) continue
                    const line = editor.state.doc.lineAt(sel.head)
                    expect(sel.head - line.from, key).toBeGreaterThanOrEqual(clampColumn(lines, line.number - 1))
                }
            }),
            fuzz(400),
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

    it('typing a character never dissolves a fenced block, blank lines written empty included', () => {
        // A block's blank line written without the fence column's spaces takes the caret at column 0.
        // A character typed on any code line, that one included, must land inside the block (Editor
        // Content Rules → The source guard).
        fc.assert(
            fc.property(outlineArb, bareBlanksArb, fc.double({ min: 0, max: 1, noNaN: true }), fc.stringMatching(/^[a-z]$/), (outline, bareBlanks, lineAt, ch) => {
                // The caret at the end of one of the blocks' code lines, each as likely as another: a
                // caret placed by character offset would almost never land on an empty line.
                const lines = render(outline, 'unit', [], [], bareBlanks).split('\n')
                const code = fencedBlocks(lines).flatMap((b) => Array.from({ length: b.end - b.start - 1 }, (_, k) => b.start + 1 + k))
                if (code.length === 0) return
                const n = code[Math.min(code.length - 1, Math.floor(lineAt * code.length))]
                const editor = editorFor(outline, 0, undefined, 'unit', [], [], bareBlanks)
                editor.select(editor.state.doc.line(n + 1).to)
                editor.type(ch)
                // The same blocks, not only as many: one character adds no line, so every block keeps
                // its fences where they were (a block dissolved while another formed would count equal).
                expect(fencedBlocks(editor.text().split('\n'))).toEqual(fencedBlocks(lines))
            }),
            fuzz(300),
        )
    })

    it('with blank code lines written empty, no structural key dissolves a block or leaves the caret left of the content column', () => {
        // The keys over the text other tools write (`bareBlanksArb`), each from the start, the fence
        // column and the end of one code line: the source guard pads a line a key leaves short of its
        // fence column and carries the caret onto the column with it (Backspace joining a line into the
        // empty one above). An empty line, or one shorter than its clamp column, holds the caret at its end.
        fc.assert(
            fc.property(outlineArb, bareBlanksArb, fc.double({ min: 0, max: 1, noNaN: true }), fc.constantFrom('start', 'column', 'end'), (outline, bareBlanks, lineAt, where) => {
                const lines = render(outline, 'unit', [], [], bareBlanks).split('\n')
                const code = fencedBlocks(lines).flatMap((b) => Array.from({ length: b.end - b.start - 1 }, (_, k) => b.start + 1 + k))
                if (code.length === 0) return
                const n = code[Math.min(code.length - 1, Math.floor(lineAt * code.length))]
                for (const key of STRUCTURAL_KEYS) {
                    const editor = editorFor(outline, 0, undefined, 'unit', [], [], bareBlanks)
                    const line = editor.state.doc.line(n + 1)
                    editor.select(where === 'start' ? line.from : where === 'column' ? line.from + lineIndent(line.text) : line.to)
                    const editsFence = editsFenceText(editor, key)
                    editor.key(key)
                    const after = editor.text().split('\n')
                    if (!editsFence) expect(fencesBalanced(after), key).toBeGreaterThanOrEqual(fencesBalanced(lines))
                    const sel = editor.state.selection.main
                    if (!sel.empty) continue
                    const at = editor.state.doc.lineAt(sel.head)
                    expect(sel.head - at.from, key).toBeGreaterThanOrEqual(Math.min(clampColumn(after, at.number - 1), at.length))
                }
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

    it('the bullet toggle among the structural keys keeps the invariants and acts exactly where its gate is live', () => {
        // The Command Bar's bullet toggle has no key, so it runs here as a pseudo-key among the structural
        // keys, over outlines with a rule (`---`) or a code block at the margin, or a rule as a bullet's text.
        const stepArb = fc.oneof({ weight: 2, arbitrary: fc.constantFrom(...STRUCTURAL_KEYS) }, { weight: 1, arbitrary: fc.constant('bullet') })
        const toggleArb = fc.record({ scenario: scenarioArb, ruleText: ruleTextArb, margin: marginArb, steps: fc.array(stepArb, { minLength: 1, maxLength: 6 }) })
        fc.assert(
            fc.property(toggleArb, ({ scenario: { outline, caretAt, selectTo }, ruleText, margin, steps }) => {
                const editor = editorFor(outline, caretAt, selectTo, 'unit', [], [], [], [], [], ruleText, margin)
                for (const step of steps) {
                    if (editsFenceText(editor, step) || editsFrontmatter(editor) || editsRule(editor, step)) return
                    const before = editor.text().split('\n')
                    if (step === 'bullet') {
                        const live = bulletToggleable(editor.state)
                        toggleBullet(editor as never)
                        // A greyed button never hides an edit, and a live one never does nothing.
                        expect(editor.text() !== before.join('\n'), 'gate').toBe(live)
                    } else editor.key(step)
                    const lines = editor.text().split('\n')
                    expect(fencesBalanced(lines), step).toBeGreaterThanOrEqual(fencesBalanced(before))
                    if (step === 'bullet') expect(frontmatterLines(lines), step).toBe(frontmatterLines(before))
                    expect(noOrphans(lines)).toBe(true)
                    expect(indentsOnGrid(lines)).toBe(true)
                    expect(markersIntact(lines)).toBe(true)
                    expect(keysAndWalkAgree(lines)).toBe(true)
                    expect(normaliseIndentUnit(editor.text())).toBe(editor.text())
                    const sel = editor.state.selection.main
                    if (!sel.empty) continue
                    const line = editor.state.doc.lineAt(sel.head)
                    expect(sel.head - line.from, step).toBeGreaterThanOrEqual(clampColumn(lines, line.number - 1))
                }
            }),
            fuzz(400),
        )
    })

    it('no key that moves or joins text re-pairs a fence or changes the frontmatter', () => {
        // A bullet's text may be a fence or a `---`, with text at the margin it could pair with once it
        // moves: leaving the list (the bullet toggle, Shift+Tab past the root), an outdent, Ctrl+Enter
        // and the Backspace and Delete joins (Editor Content Rules → Shift+Tab past the root). Those keys
        // alone, so no other key's gap is in the way. Backspace and Delete are pressed where they join.
        const leaveArb = fc.record({
            scenario: scenarioArb,
            edgeText: edgeTextArb,
            margin: marginArb,
            steps: fc.array(fc.constantFrom('bullet', 'Shift-Tab', 'Mod-Enter', 'Backspace', 'Delete'), { minLength: 1, maxLength: 4 }),
        })
        fc.assert(
            fc.property(leaveArb, ({ scenario: { outline, caretAt, selectTo }, edgeText, margin, steps }) => {
                const editor = editorFor(outline, caretAt, selectTo, 'unit', [], [], [], [], [], edgeText, margin)
                for (const step of steps) {
                    if (editsFrontmatter(editor)) return
                    if ((step === 'Backspace' || step === 'Delete') && !placeForJoin(editor, step)) continue
                    const before = editor.text().split('\n')
                    // A fence just written on its own line is held pending: the editor reads the lines after
                    // it as text until the document balances, so a step may edit what the plain scan pairs
                    // as code. That is the pending fence's design, not a pairing changed.
                    const pending = analysisFor(editor.state).pendingFence !== null
                    if (step === 'bullet') {
                        const live = bulletToggleable(editor.state)
                        toggleBullet(editor as never)
                        expect(editor.text() !== before.join('\n'), 'gate').toBe(live)
                    } else editor.key(step)
                    const lines = editor.text().split('\n')
                    if (!pending) {
                        expect(codeHeld(lines), step).toBe(codeHeld(before))
                        // A step that adds no line, and lost none to the tidy, keeps every line's standing as
                        // code, line by line. Ctrl+Enter adds the line it carries text to, and the tidy can take
                        // one away above it, so its lines are matched by content alone.
                        if (step !== 'Mod-Enter' && lines.length === before.length) {
                            expect(opaqueLineFlags(lines, fencedBlocks(lines)), step).toEqual(opaqueLineFlags(before, fencedBlocks(before)))
                        }
                    }
                    expect(frontmatterLines(lines), step).toBe(frontmatterLines(before))
                    expect(noOrphans(lines)).toBe(true)
                    expect(markersIntact(lines)).toBe(true)
                }
            }),
            fuzz(400),
        )
    })

    it('in a code sample that holds fenced blocks of its own, the code keys never dissolve a block', () => {
        // An outline written inside a markdown sample: an outer fence around it (three backticks, or the
        // four the docs advise), the outline's own code blocks nested in it. Every line of it is code, and
        // the inner pairs are blocks the keys edit in: their fences are structure, so no key splits,
        // joins or moves one off its partner's column, from a caret or over a range.
        const keyArb = fc.array(
            fc.constantFrom('Enter', 'Shift-Enter', 'Backspace', 'Delete', 'Mod-Backspace', 'Mod-Delete', 'Tab', 'Shift-Tab', 'Mod-Enter', 'Alt-ArrowUp', 'Alt-ArrowDown'),
            { minLength: 1, maxLength: 4 },
        )
        const placeArb = fc.record({
            outer: fc.constantFrom('```', '````'),
            lineAt: fc.double({ min: 0, max: 1, noNaN: true }),
            where: fc.constantFrom('start', 'column', 'end'),
            /** Sometimes a range instead: from the caret to this far down the sample's lines. */
            selectTo: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
        })
        fc.assert(
            fc.property(outlineArb, placeArb, keyArb, (outline, { outer, lineAt, where, selectTo }, keys) => {
                const doc = [`${outer}md`, render(outline), outer].join('\n')
                const editor = editorFixture('|' + doc)
                const inside = editor.state.doc.lines - 2
                const line = editor.state.doc.line(2 + Math.min(inside - 1, Math.floor(lineAt * inside)))
                const caret = where === 'start' ? line.from : where === 'column' ? line.from + lineIndent(line.text) : line.to
                editor.select(caret)
                if (selectTo !== undefined) {
                    const last = editor.state.doc.line(line.number + Math.round(selectTo * (inside + 1 - line.number)))
                    editor.select(caret, last.to)
                }
                let count = fencesBalanced(editor.text().split('\n'))
                for (const key of keys) {
                    // Deleting a fence's own characters dissolves its block on purpose.
                    const editsFence = editsFenceText(editor, key)
                    editor.key(key)
                    const next = fencesBalanced(editor.text().split('\n'))
                    if (!editsFence) expect(next, key).toBeGreaterThanOrEqual(count)
                    count = next
                }
            }),
            fuzz(300),
        )
    })

    it('Mod-z restores the exact text and caret after a bullet toggle', () => {
        fc.assert(
            fc.property(scenarioArb, edgeTextArb, marginArb, ({ outline, caretAt, selectTo }, edgeText, margin) => {
                const editor = editorFor(outline, caretAt, selectTo, 'unit', [], [], [], [], [], edgeText, margin)
                const before = editor.fixture()
                if (!toggleBullet(editor as never)) return
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

// ── Map widgets ──────────────────────────────────────────────────────────────────────────────

/**
 * Maps (ADR 0118) drawn over some of the generated code blocks, and over prose maps at the edges of
 * the body: at its start (after the frontmatter, when there is one) and at its end. A map is drawn
 * while no selection touches it and shows its text while one does, as a rendered fence (ADR 0022),
 * so a key may show a map's text and edit it there, but a map the key leaves drawn must hold the text
 * of a map before it: no key changes text the person cannot see. The keys are pressed as the live
 * editor runs them, the map's own keys first, so the property hunts what neither keymap's rows pin
 * down alone.
 */
describe('map widgets under random key sequences', () => {
    const widget: InteractiveFence = { height: () => 320, mount: () => ({ update: () => {}, destroy: () => {} }) }
    beforeEach(() => {
        const registry = createContributionRegistry()
        registerInteractiveFence(registry, 'map', widget)
        setActiveContributionRegistry(registry)
    })
    afterEach(() => setActiveContributionRegistry(null))

    /** Prose maps around the outline: touching it, or with a line between. */
    const mapMarginArb: fc.Arbitrary<Margin> = fc.record({
        above: fc.constantFrom<string[]>([], ['```map', 'Top @ 1, 2', '```'], ['```map', 'Top @ 1, 2', '```', '']),
        below: fc.constantFrom<string[]>([], ['```map', 'End @ 3, 4', '```'], ['', '```map', 'End @ 3, 4', '```']),
    })
    /** Which of the outline's code blocks are maps, in order. */
    const asMapArb = fc.array(fc.boolean(), { minLength: 7, maxLength: 7 })
    /** Which maps have a second map straight after them, with no line between. */
    const doubledArb = fc.array(fc.boolean(), { minLength: 7, maxLength: 7 })
    const MAP_KEYS = [...STRUCTURAL_KEYS, 'Shift-Backspace', 'Mod-Backspace', 'Mod-Delete', 'Mod-]', 'Mod-[', 'ArrowLeft', 'ArrowRight']
    /**
     * CodeMirror's own commands the outliner leaves bound, which do not know the outline: its deletes
     * for a caret take a bullet's marker or join a child's line onto it, and its Mod-] and Mod-[
     * indent lines with no regard for their parents, whether or not a map is near (a gap of the
     * outliner's, not of the maps). After one of them only the maps are judged.
     */
    const PAST_THE_OUTLINER = new Set(['Shift-Backspace', 'Mod-Backspace', 'Mod-Delete', 'Mod-]', 'Mod-['])
    const mapScenarioArb = fc.record({
        outline: outlineArb,
        caretAt: fc.double({ min: 0, max: 1, noNaN: true }),
        selectTo: fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: undefined }),
        keys: fc.array(fc.constantFrom(...MAP_KEYS), { minLength: 1, maxLength: 6 }),
    })

    /** A key as the live editor runs it: every binding in precedence order, then the default; an arrow as the one-character move CodeMirror makes. */
    function pressLive(editor: HeadlessEditor, key: string): void {
        const head = editor.state.selection.main.head
        if (key === 'ArrowLeft') return editor.select(Math.max(0, head - 1))
        if (key === 'ArrowRight') return editor.select(Math.min(editor.state.doc.length, head + 1))
        for (const binding of editor.state.facet(keymap).flat()) {
            if (binding.key === key && binding.run?.(editor as never)) return
        }
        editor.key(key)
    }

    /** A key deleting a code block's own fence characters, which dissolves it on purpose, as the plain properties skip. */
    function editsCodeFenceText(editor: HeadlessEditor, key: string): boolean {
        return editsFenceText(editor, key === 'Shift-Backspace' ? 'Backspace' : key)
    }

    /** Each map's text, or each drawn map's: what a key may move, indent or delete whole, but never change unseen. */
    const mapTexts = (editor: HeadlessEditor) => interactiveFences(editor.state).map((f) => f.body.join('\n'))
    const drawnTexts = (editor: HeadlessEditor) => collapsedInteractiveFences(editor.state).map((f) => f.body.join('\n'))

    /** Whether every text in `after` was one in `before`, as many times over. */
    function keptFrom(after: string[], before: string[]): boolean {
        const left = [...before]
        return after.every((text) => {
            const i = left.indexOf(text)
            if (i < 0) return false
            left.splice(i, 1)
            return true
        })
    }

    it('no key changes a map it leaves drawn, and the outline keeps its invariants', () => {
        fc.assert(
            fc.property(mapScenarioArb, asMapArb, doubledArb, mapMarginArb, frontmatterArb, formOneArb, ({ outline, caretAt, selectTo, keys }, asMap, doubled, margin, frontmatter, formOne) => {
                const lines = render(outline, 'unit', [], [], [], formOne, frontmatter, [], margin).split('\n')
                const body = frontmatterLines(lines)
                let n = 0
                const maps: { start: number; end: number; double: boolean }[] = []
                for (const block of fencedBlocks(lines)) {
                    if (block.start < body || /```map\s*$/.test(lines[block.start])) continue
                    const k = n++ % asMap.length
                    if (!asMap[k]) continue
                    // The info word is the map's, whatever the fence had (a form-1 opener may carry one).
                    lines[block.start] = lines[block.start].replace(/(`{3,})\S*\s*$/, '$1map')
                    maps.push({ start: block.start, end: block.end, double: doubled[k] })
                }
                // From the last up, so the earlier blocks' lines stay where they were.
                for (const map of maps.reverse()) {
                    if (map.double) lines.splice(map.end + 1, 0, ...lines.slice(map.start, map.end + 1))
                }
                const doc = lines.join('\n')
                const from = frontmatter.length ? frontmatter.join('\n').length + 1 : 0
                const pos = Math.round(from + caretAt * (doc.length - from))
                // The caret starts at the body's start and is placed through a selection, as a click
                // places it: the fixture's own caret bypasses the filters.
                const editor = editorFixture(`${doc.slice(0, from)}|${doc.slice(from)}`, { extensions: [interactiveFenceAugmentation()] })
                editor.select(pos)
                if (selectTo !== undefined) editor.select(pos, pos + Math.round(selectTo * (doc.length - pos)))
                let outlineJudged = true
                for (const key of keys) {
                    if (editsCodeFenceText(editor, key) || editsFrontmatter(editor)) return
                    if (PAST_THE_OUTLINER.has(key)) outlineJudged = false
                    const texts = mapTexts(editor)
                    pressLive(editor, key)
                    const now = editor.text().split('\n')
                    if (outlineJudged) {
                        expect(noOrphans(now)).toBe(true)
                        expect(indentsOnGrid(now)).toBe(true)
                        expect(markersIntact(now)).toBe(true)
                    }
                    // A map the key leaves drawn holds the text of a map before it: a key that edits a
                    // map's text leaves the caret in it, which shows the text.
                    const drawn = drawnTexts(editor)
                    expect(keptFrom(drawn, texts), `${key}: ${JSON.stringify(texts)} -> ${JSON.stringify(drawn)}`).toBe(true)
                    const sel = editor.state.selection.main
                    if (!sel.empty || !outlineJudged) continue
                    const line = editor.state.doc.lineAt(sel.head)
                    expect(sel.head - line.from, key).toBeGreaterThanOrEqual(clampColumn(now, line.number - 1))
                }
            }),
            fuzz(400),
        )
    })
})
