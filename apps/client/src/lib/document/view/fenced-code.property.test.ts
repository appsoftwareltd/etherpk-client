/**
 * Property tests over fenced code blocks in the headless editor: the keys and edits made INSIDE a
 * block, its pairing, stray fences, pastes into code, fence completion, undo, and the Derived Index's
 * agreement with what the editor shows. Each property is a sentence of Editor Content Rules.md →
 * Fenced Code Blocks, named in its comment.
 *
 * `outliner-invariants.property.test.ts` fuzzes the structural keys from anywhere in an outline that
 * holds fences, and checks that the count of complete blocks never drops. These start the caret in a
 * block and check more: the same blocks, paired the same way, the code's own indentation, and the
 * caret held at the fence column.
 *
 * The generated documents carry the shapes that broke fences before (the git history and the rule
 * rows): form-1 openers on bullet lines, form-2 blocks under bullets and tasks, prose blocks at column
 * 0, info strings, four-backtick blocks holding three-backtick samples, blank code lines written empty
 * as other tools write them, tab-indented code, code that looks like structure (`- x`, `# c`), stray
 * unterminated fences between blocks, and pastes of indented code.
 *
 * A property the code breaks is kept and marked `it.fails`, with the shrunk counterexample in its
 * comment, so the suite stays green and turns red the day the code is fixed. The general properties
 * leave out the one shape each such test isolates, and say so. A test whose comment starts "Was" pins
 * a bug that was fixed; its shape is in the general properties too.
 */

import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { codeLineText, type FencedBlockRange, fencedBlocks, fenceLineInfo, tidiedFenceLine } from '../fenced-code'
import { deriveDoc } from '../index-derive'
import { analysisFor } from './analysis/editor-analysis'
import { checkboxClick } from './augmentations/task-checkbox'
import { editorFixture, type HeadlessEditor } from './testing/editor-state-fixture'

/**
 * Fixed seeds keep the suite deterministic in CI. To hunt for new counterexamples, run with
 * `EDITOR_FUZZ_SEED=<n>` (any integer) and optionally `EDITOR_FUZZ_RUNS=<n>`; a failure prints the
 * seed and path that reproduce it, which then belongs in the rules test as a row.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return {
        numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs),
        seed: seed === undefined ? 20261116 : Number(seed),
    }
}

// ── Generators ───────────────────────────────────────────────────────────────────────────────

/** A line of code: its own indentation past the fence column (spaces, or a tab), and its text. */
interface CodeLine {
    extra: number
    tab: boolean
    text: string
}

/** A three-backtick sample inside a four-backtick block, two columns deeper than the block's fence or at it. */
interface Sample {
    sample: true
    pad: number
}

interface BlockSpec {
    run: string
    info: string
    code: (CodeLine | Sample)[]
    /** Blank code lines written empty, without the fence column's spaces (as other tools write them). */
    bareBlanks: boolean
}

type Item =
    | { kind: 'bullet'; step: number; task: boolean; text: string; block: BlockSpec | null; onLine: boolean; soft: string | null }
    | { kind: 'prose'; text: string }
    | { kind: 'proseBlock'; block: BlockSpec }
    | { kind: 'blank' }
    | { kind: 'stray'; run: string; info: string; deep: boolean }

const wordArb = fc.constantFrom('water the beans', 'Garden', 'dig the bed', 'Kitchen')
const codeTextArb = fc.constantFrom('return 1', 'if x:', 'water(beans)', '', '', '- x', '# c', '- [ ] buy seeds', '  - y')

const codeLineArb: fc.Arbitrary<CodeLine> = fc.record({ extra: fc.constantFrom(0, 0, 0, 1, 2, 4), tab: fc.constant(false), text: codeTextArb })
const tabbedCodeLineArb: fc.Arbitrary<CodeLine> = fc.record({ extra: fc.constant(0), tab: fc.constant(true), text: fc.constantFrom('return 1', 'water(beans)') })

/**
 * A block. `samplePads` says where a three-backtick sample may sit in a four-backtick block: two
 * columns deeper, where it is a block of its own nested in the sample, or at the block's own column,
 * where it is content (a shorter same-column fence).
 */
function blockArb(samplePads: number[]): fc.Arbitrary<BlockSpec> {
    return fc
        .record({
            run: fc.constantFrom('```', '```', '````'),
            info: fc.constantFrom('', '', 'py', 'md'),
            code: fc.array(fc.oneof({ weight: 6, arbitrary: codeLineArb }, { weight: 1, arbitrary: tabbedCodeLineArb }, { weight: 1, arbitrary: fc.record({ sample: fc.constant(true as const), pad: fc.constantFrom(...samplePads) }) }), { minLength: 0, maxLength: 4 }),
            bareBlanks: fc.boolean(),
        })
        // A three-backtick sample sits only in a four-backtick block: in a three-backtick one its closer
        // would close the block (the docs advise the longer outer fence).
        .map((b) => ({ ...b, code: b.run === '````' ? b.code : b.code.filter((c) => !('sample' in c)) }))
}

function itemArb(block: fc.Arbitrary<BlockSpec>): fc.Arbitrary<Item> {
    const bullet: fc.Arbitrary<Item> = fc.record({
        kind: fc.constant('bullet' as const),
        step: fc.constantFrom(-1, 0, 1),
        task: fc.boolean(),
        text: wordArb,
        block: fc.option(block, { nil: null, freq: 2 }),
        onLine: fc.boolean(),
        soft: fc.option(wordArb, { nil: null, freq: 3 }),
    })
    return fc.oneof(
        { weight: 6, arbitrary: bullet },
        { weight: 1, arbitrary: wordArb.map((text) => ({ kind: 'prose' as const, text })) },
        { weight: 2, arbitrary: block.map((b) => ({ kind: 'proseBlock' as const, block: b })) },
        { weight: 1, arbitrary: fc.constant({ kind: 'blank' as const }) },
    )
}

/** A stray unterminated fence: at the margin, or (after a bullet) at its content column as one of its lines. */
const strayArb: fc.Arbitrary<Item> = fc.record({ kind: fc.constant('stray' as const), run: fc.constantFrom('```', '````'), info: fc.constantFrom('', 'js'), deep: fc.boolean() })

/** Samples two columns deeper than their block's fence, or at its column. */
const plainItemArb = itemArb(blockArb([2, 0]))
/** A document of complete blocks, as the editor writes them. */
const docArb = fc.array(plainItemArb, { minLength: 1, maxLength: 7 })
/** The same with stray unterminated fences between the items, as other tools and half-finished edits leave. */
const strayDocArb = fc.array(fc.oneof({ weight: 5, arbitrary: plainItemArb }, { weight: 1, arbitrary: strayArb }), { minLength: 1, maxLength: 8 })

function codeLines(block: BlockSpec, column: number): string[] {
    const col = ' '.repeat(column)
    return block.code.flatMap((c) => {
        if ('sample' in c) {
            const at = col + ' '.repeat(c.pad)
            return [`${at}\`\`\`js`, `${at}return 1`, `${at}\`\`\``]
        }
        if (c.text === '') return [block.bareBlanks ? '' : col]
        return [`${col}${' '.repeat(c.extra)}${c.tab ? '\t' : ''}${c.text}`]
    })
}

/** Render items to lines. Bullets stay on the two-space grid, each at most one level below the one before. */
function render(items: Item[]): string[] {
    const lines: string[] = []
    let level = -1 // the previous bullet's level in this group, -1 when none
    for (const item of items) {
        if (item.kind === 'stray') {
            // A deep stray is a line of the bullet above, at its content column; with no bullet above it
            // is a prose line with two leading spaces.
            lines.push(`${item.deep ? ' '.repeat(level >= 0 ? level * 2 + 2 : 2) : ''}${item.run}${item.info}`)
            continue
        }
        if (item.kind !== 'bullet') {
            level = -1
            if (item.kind === 'prose') lines.push(item.text)
            else if (item.kind === 'blank') lines.push('')
            else lines.push(`${item.block.run}${item.block.info}`, ...codeLines(item.block, 0), item.block.run)
            continue
        }
        level = level < 0 ? 0 : Math.max(0, Math.min(level + 1, level + item.step))
        const indent = '  '.repeat(level)
        const column = indent.length + 2
        const col = ' '.repeat(column)
        const marker = item.task ? '- [ ] ' : '- '
        // A task's fence cannot open on its line: its backticks would sit past the content column.
        if (item.block && item.onLine && !item.task) {
            lines.push(`${indent}- ${item.block.run}${item.block.info}`, ...codeLines(item.block, column), `${col}${item.block.run}`)
            if (item.soft) lines.push(`${col}${item.soft}`)
        } else {
            lines.push(`${indent}${marker}${item.text}`)
            if (item.soft) lines.push(`${col}${item.soft}`)
            if (item.block) lines.push(`${col}${item.block.run}${item.block.info}`, ...codeLines(item.block, column), `${col}${item.block.run}`)
        }
    }
    return lines
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

/** Each block as a comparable word: its depth among blocks, its run and its info string. */
function blockWords(lines: readonly string[], blocks: readonly FencedBlockRange[]): { outer: string[]; all: string[] } {
    const sorted = [...blocks].sort((a, b) => a.start - b.start)
    const depth = (b: FencedBlockRange) => sorted.filter((o) => o.start < b.start && b.end < o.end).length
    const word = (b: FencedBlockRange) => {
        const f = fenceLineInfo(lines[b.start])!
        return `${depth(b)}:${f.run}${f.info}`
    }
    return { outer: sorted.filter((b) => depth(b) === 0).map(word).sort(), all: sorted.map(word).sort() }
}

/** Whether `small` is a sub-multiset of `big`. */
function within(small: readonly string[], big: readonly string[]): boolean {
    const left = [...big]
    return small.every((s) => {
        const i = left.indexOf(s)
        if (i < 0) return false
        left.splice(i, 1)
        return true
    })
}

const fenceLineCount = (lines: readonly string[]) => lines.filter((l) => fenceLineInfo(l) !== null).length
const blockKey = (b: FencedBlockRange) => `${b.start}:${b.end}:${b.fenceColumn}`

/** The innermost block holding 0-based line `i` past its opener (a code line or the closer). */
function innermost(blocks: readonly FencedBlockRange[], i: number): FencedBlockRange | null {
    return blocks.filter((b) => b.start < i && i <= b.end).sort((a, b) => b.start - a.start)[0] ?? null
}

/** The code lines of a document, as the code's own text past their innermost block's fence column. */
function codeTexts(lines: readonly string[], blocks: readonly FencedBlockRange[], skip: (i: number) => boolean = () => false): string[] {
    const out: string[] = []
    lines.forEach((line, i) => {
        const block = innermost(blocks, i)
        if (!block || i === block.end || skip(i) || fenceLineInfo(line)) return
        out.push(codeLineText(line, block.fenceColumn))
    })
    return out.sort()
}

/** The keys a person presses with the caret in a block. Characters are typed; arrows move the caret. */
const IN_BLOCK_KEYS = [
    'x',
    ' ',
    'Enter',
    'Shift-Enter',
    'Tab',
    'Shift-Tab',
    'Backspace',
    'Delete',
    'Home',
    'End',
    'Shift-Home',
    'Shift-End',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Shift-ArrowLeft',
    'Shift-ArrowRight',
    'Mod-Enter',
    'Alt-ArrowUp',
    'Alt-ArrowDown',
    'Mod-Backspace',
    'Mod-Delete',
]
const DELETING = new Set(['Backspace', 'Delete', 'Mod-Backspace', 'Mod-Delete'])
/** The keys that replace a selection with what they type or delete. */
const REPLACING = new Set(['x', ' ', 'Enter', 'Shift-Enter', 'Mod-Enter', ...DELETING])

/**
 * Press a key as the live editor would: typed characters through the input path, arrows as the
 * one-position or one-line moves CodeMirror makes (through a selection transaction, so the caret
 * clamp applies), everything else through the keymap with CodeMirror's default under it.
 */
function press(editor: HeadlessEditor, key: string): void {
    const { state } = editor
    const sel = state.selection.main
    const line = state.doc.lineAt(sel.head)
    if (key === 'x' || key === ' ') return editor.type(key)
    if (key === 'ArrowLeft') return editor.select(sel.empty ? Math.max(0, sel.head - 1) : sel.from)
    if (key === 'ArrowRight') return editor.select(sel.empty ? Math.min(state.doc.length, sel.head + 1) : sel.to)
    if (key === 'Shift-ArrowLeft') return editor.select(sel.anchor, Math.max(0, sel.head - 1))
    if (key === 'Shift-ArrowRight') return editor.select(sel.anchor, Math.min(state.doc.length, sel.head + 1))
    if (key === 'ArrowUp' || key === 'ArrowDown') {
        const n = line.number + (key === 'ArrowUp' ? -1 : 1)
        if (n < 1 || n > state.doc.lines) return editor.select(key === 'ArrowUp' ? 0 : state.doc.length)
        const target = state.doc.line(n)
        return editor.select(target.from + Math.min(sel.head - line.from, target.length))
    }
    if (editor.key(key)) return
    // CodeMirror's own Home and End where the outliner yields (the line boundary; the clamp snaps it).
    if (key === 'Home' || key === 'End') return editor.select(key === 'Home' ? line.from : line.to)
    if (key === 'Shift-Home' || key === 'Shift-End') return editor.select(sel.anchor, key === 'Shift-Home' ? line.from : line.to)
}

/**
 * Whether `key` edits a fence's own text: its backticks or info string, a character typed on its line,
 * or a line a selection reaches. "Deleting a backtick itself is still allowed; that is how a block is
 * dissolved on purpose", and "an edit to a fence line itself ... is left to dissolve the block". The
 * caret at the end of a fence line is not editing it (Enter, Delete and Mod+Delete there are
 * structure keys), nor is Backspace at its column (a join, which is consumed).
 */
function editsFenceText(editor: HeadlessEditor, key: string): boolean {
    const { state } = editor
    const sel = state.selection.main
    if (!sel.empty) {
        if (!REPLACING.has(key)) return false
        const first = state.doc.lineAt(sel.from).number
        const last = state.doc.lineAt(sel.to).number
        for (let n = first; n <= last; n++) if (fenceLineInfo(state.doc.line(n).text)) return true
        return false
    }
    const line = state.doc.lineAt(sel.head)
    const f = fenceLineInfo(line.text)
    if (!f) return false
    const runStart = line.from + f.col
    const textEnd = line.from + line.text.trimEnd().length
    // Enter inside the backticks of a fence no block pairs acts at its end, as on a block's fence line,
    // and on an opener with no closer that completes it: a block added on purpose. The property in
    // "fence completion" checks it.
    const index = line.number - 1
    const paired = analysisFor(state).fencedBlocks.some((b) => b.start === index || b.end === index)
    if ((key === 'Enter' || key === 'Shift-Enter') && !paired) return sel.head > runStart && sel.head < runStart + f.len
    // A character typed anywhere on a fence line edits it: in front of the run it moves the fence or
    // stops it being one, after it it changes the info string.
    if (key === 'x' || key === ' ') return true
    if (key === 'Backspace' || key === 'Mod-Backspace') return sel.head > runStart
    if (key === 'Delete') return sel.head >= runStart && sel.head < textEnd
    // A word delete from the fence's indent runs on into its backticks: "one that takes the fence's own
    // text (its info string, its backticks) deletes it".
    if (key === 'Mod-Delete') return sel.head >= line.from && sel.head < textEnd
    return false
}

/**
 * Whether the opener at line `k` opens a block without taking any block's fence: every fence that
 * pairs with line `k` set aside is still in a block with it there. An opener that takes a fence is the
 * one "typed above an existing block", which "pairs, under the raw first-with-next scan, with that
 * block's bare opener", and leaves that block's closer outside every block.
 */
function opensWithoutTakingAFence(lines: readonly string[], k: number): boolean {
    const blocks = fencedBlocks(lines)
    if (!blocks.some((b) => b.start === k)) return false
    const inBlock = (i: number) => blocks.some((b) => b.start <= i && i <= b.end)
    return fencedBlocks(lines.map((l, i) => (i === k ? l.replace(/`+/, 'x') : l))).every((b) => inBlock(b.start) && inBlock(b.end))
}

/**
 * Enter at the end of a block's opener that took a block's fence to pair. By design that is read as
 * an opener typed above a block, "so the new opener still completes and the block below keeps its
 * fences". The text cannot tell it from a block above a stray fence, so Enter adds a pair there, and
 * the properties that say Enter never does leave it out.
 */
function entersOpenerThatTookAFence(editor: HeadlessEditor, key: string): boolean {
    if (key !== 'Enter') return false
    const { state } = editor
    const line = state.doc.lineAt(state.selection.main.head)
    const at = line.number - 1
    if (!analysisFor(state).fencedBlocks.some((b) => b.start === at) || state.selection.main.head < line.from + line.text.trimEnd().length) return false
    return !opensWithoutTakingAFence(editor.text().split('\n'), at)
}

/** Where on a line the caret starts: the line's start, the fence column, the code's start, its middle or its end. */
type Where = 'start' | 'column' | 'code' | 'middle' | 'end'
const whereArb = fc.constantFrom<Where>('start', 'column', 'code', 'middle', 'end')

function caretOn(editor: HeadlessEditor, lineIndex: number, column: number, where: Where): number {
    const line = editor.state.doc.line(lineIndex + 1)
    const code = line.text.length - line.text.trimStart().length
    const at = { start: 0, column, code, middle: Math.floor((code + line.length) / 2), end: line.length }[where]
    return line.from + Math.min(at, line.length)
}

/** A scenario: a document, a block in it, a line of that block, where on it, and maybe a selection down the block. */
const scenarioArb = fc.record({
    items: fc.oneof({ weight: 3, arbitrary: docArb }, { weight: 1, arbitrary: strayDocArb }),
    block: fc.nat(),
    line: fc.nat(),
    where: whereArb,
    /** Sometimes a selection instead: from the caret to this many lines further down the block. */
    span: fc.option(fc.nat({ max: 3 }), { nil: undefined, freq: 4 }),
    keys: fc.array(fc.constantFrom(...IN_BLOCK_KEYS), { minLength: 1, maxLength: 8 }),
})

interface Placed {
    editor: HeadlessEditor
    /** The document as rendered, before the caret was placed. */
    rendered: string
    block: FencedBlockRange
}

/** The editor over the scenario's document with the caret (or a selection) in one of its blocks, or null when it has none. */
function place(s: { items: Item[]; block: number; line: number; where: Where; span?: number }, codeOnly = false): Placed | null {
    const lines = render(s.items)
    const blocks = fencedBlocks(lines)
    if (blocks.length === 0) return null
    const block = blocks[s.block % blocks.length]
    // The block's lines, its fences included unless only code lines are wanted.
    const first = codeOnly ? block.start + 1 : block.start
    const last = codeOnly ? block.end - 1 : block.end
    if (last < first) return null
    const index = first + (s.line % (last - first + 1))
    const editor = editorFixture('|' + lines.join('\n'))
    // Placed through a selection transaction, so the caret clamp applies as for a click.
    editor.select(caretOn(editor, index, block.fenceColumn, s.where))
    if (s.span !== undefined) {
        const to = Math.min(last, index + s.span)
        editor.select(editor.state.selection.main.head, caretOn(editor, to, block.fenceColumn, 'end'))
    }
    return { editor, rendered: lines.join('\n'), block }
}

// Each property replays a fixed, seeded batch of key sequences, a few hundred milliseconds alone and
// many times that when `pnpm test` runs every package's suite at once. Vitest's 5 s default is a hang
// guard, which a busy machine trips on fixed work; a real hang still fails, at 30 s.
describe('fenced blocks under the keys pressed inside them', { timeout: 30_000 }, () => {
    it('no key pressed in a block re-pairs a fence: the same blocks stay, paired the same way, unless a fence’s own text is edited', () => {
        // "An opener pairs only with a bare closer at its own column and of exactly its own length",
        // and the keys inside a block keep it so: Enter and Shift+Enter are newlines "clamped to the
        // fence column", Backspace "never merges content onto the opening fence", Delete at a fence
        // edge is "Consumed: a join never crosses a fence edge", Tab and Shift+Tab never move a code
        // line "left of the fence column", Alt+Up/Down never cross a fence, and Mod+Enter leaves the
        // block. "Deleting a backtick itself is still allowed; that is how a block is dissolved on
        // purpose": a key that edits a fence's own text ends the sequence. So does Enter on an opener
        // that took a block's fence, which completes it by design (`entersOpenerThatTookAFence`).
        fc.assert(
            fc.property(scenarioArb, (s) => {
                const placed = place(s)
                if (!placed) return
                const { editor } = placed
                for (const key of s.keys) {
                    if (editsFenceText(editor, key) || entersOpenerThatTookAFence(editor, key)) return
                    const before = editor.text().split('\n')
                    const fixture = editor.fixture()
                    const was = blockWords(before, analysisFor(editor.state).fencedBlocks)
                    press(editor, key)
                    const after = editor.text().split('\n')
                    const now = blockWords(after, analysisFor(editor.state).fencedBlocks)
                    const info = `${key} on ${JSON.stringify(fixture)} gave ${JSON.stringify(editor.fixture())}`
                    expect(now.outer, info).toEqual(was.outer)
                    expect(within(was.all, now.all), info).toBe(true)
                    // Unpaired fence lines are not counted: one is plain text ("An unterminated opener
                    // yields no block"), which tidy on leave pulls up onto an empty bullet as it would any
                    // first content line, and Mod+Enter carries a bullet's text out to the margin, where it
                    // may read as a fence that pairs with nothing (refused only "where the fence it carries
                    // out would pair with another fence").
                }
            }),
            fuzz(500),
        )
    })

    it('the caret never rests left of the fence column on a line of a block', () => {
        // "The caret clamp holds inside blocks too: the caret cannot rest left of the fence column". A
        // blank line shorter than the column holds the caret at its end ("A blank line, or one holding
        // fewer spaces than the fence column, is drawn from the fence column too"). A character typed
        // onto a fence's own text ends the sequence; a space typed at a closer's column has a property
        // of its own below.
        fc.assert(
            fc.property(scenarioArb, (s) => {
                const placed = place(s)
                if (!placed) return
                const { editor } = placed
                for (const key of s.keys) {
                    if (editsFenceText(editor, key)) return
                    const fixture = editor.fixture()
                    press(editor, key)
                    const sel = editor.state.selection.main
                    if (!sel.empty) continue
                    const line = editor.state.doc.lineAt(sel.head)
                    const block = innermost(analysisFor(editor.state).fencedBlocks, line.number - 1)
                    if (!block) continue
                    const info = `${key} on ${JSON.stringify(fixture)} gave ${JSON.stringify(editor.fixture())}`
                    expect(sel.head - line.from, info).toBeGreaterThanOrEqual(Math.min(block.fenceColumn, line.length))
                }
            }),
            fuzz(500),
        )
    })

    it('a key keeps the own indentation of every code line it was not pressed on', () => {
        // "A body line keeps its indentation (CommonMark)": a line's spaces past the fence column are
        // the code's own. Only the caret's lines (and, for a delete, the line it joins) may change; a
        // block that moves as a unit keeps every line's indentation past its column, a tab included.
        // Enter on an opener that took a block's fence completes it by design and leaves the code below
        // the new block as text (`entersOpenerThatTookAFence`), so it ends the sequence.
        fc.assert(
            fc.property(scenarioArb, (s) => {
                const placed = place(s)
                if (!placed) return
                const { editor } = placed
                for (const key of s.keys) {
                    if (editsFenceText(editor, key) || entersOpenerThatTookAFence(editor, key)) return
                    const { state } = editor
                    const before = editor.text().split('\n')
                    const fixture = editor.fixture()
                    const reach = DELETING.has(key) ? 1 : 0
                    const first = state.doc.lineAt(state.selection.main.from).number - 1 - reach
                    const last = state.doc.lineAt(state.selection.main.to).number - 1 + reach
                    const kept = codeTexts(before, analysisFor(state).fencedBlocks, (i) => i >= first && i <= last)
                    press(editor, key)
                    const now = codeTexts(editor.text().split('\n'), analysisFor(editor.state).fencedBlocks)
                    expect(within(kept, now), `${key} on ${JSON.stringify(fixture)} gave ${JSON.stringify(editor.fixture())}`).toBe(true)
                }
            }),
            fuzz(500),
        )
    })

    it('undoing every step of a sequence gives back the document', () => {
        // Every key is an undoable edit, and the source guard's corrections "ride the same transaction
        // (so one paste is one undo step)"; tidy on leave rides the move that left. Undoing as many
        // times as there were steps restores the text as it was before the caret was placed.
        fc.assert(
            fc.property(scenarioArb, (s) => {
                const placed = place(s)
                if (!placed) return
                const { editor, rendered } = placed
                const trail: string[] = []
                for (const key of s.keys) {
                    press(editor, key)
                    trail.push(`${key} -> ${JSON.stringify(editor.fixture())}`)
                }
                // The keys, and up to two placing moves before them.
                for (let n = 0; n < s.keys.length + 2; n++) editor.key('Mod-z')
                expect(editor.text(), `${JSON.stringify(rendered)}\n${trail.join('\n')}`).toBe(rendered)
            }),
            fuzz(500),
        )
    })
})

describe('code indentation with Tab and Shift+Tab', { timeout: 30_000 }, () => {
    /** Whitespace-only lines as empty: a blank code line's spaces are never drawn (it is drawn from the fence column). */
    const blanksAside = (text: string) => text.replace(/^[ \t]+$/gm, '')

    /**
     * Tab then Shift+Tab at the placed caret or over the placed selection, and the check that they gave
     * back the text and the selection. With `onlyTabbed`, only where a line touched is indented with a
     * tab; any other placement is skipped.
     */
    function roundTrip(placed: Placed, onlyTabbed = false): void {
        const { editor } = placed
        const { state } = editor
        const sel = state.selection.main
        const first = state.doc.lineAt(sel.from).number
        const last = state.doc.lineAt(sel.to).number
        // A selected line short of the fence column comes back padded, and an end of the selection
        // on it with the padding: the selection is then compared only where no line was short.
        let short = false
        let tabbed = false
        for (let n = first; n <= last; n++) {
            const text = state.doc.line(n).text
            if (!sel.empty && fenceLineInfo(text)) return
            if (text.length < placed.block.fenceColumn) short = true
            if (/^\s*\t/.test(text)) tabbed = true
        }
        if (onlyTabbed && !tabbed) return
        // At a caret, only in the line's own indentation.
        if (sel.empty) {
            const line = state.doc.lineAt(sel.head)
            if (sel.head - line.from > line.text.length - line.text.trimStart().length) return
        }
        const before = editor.fixture()
        editor.key('Tab')
        const tabbedText = editor.fixture()
        editor.key('Shift-Tab')
        const info = `${JSON.stringify(before)} -> Tab ${JSON.stringify(tabbedText)} -> Shift-Tab ${JSON.stringify(editor.fixture())}`
        expect(blanksAside(editor.text()), info).toBe(blanksAside(before.replace(/[|«»]/g, '')))
        if (!sel.empty && !short) expect([editor.state.selection.main.anchor, editor.state.selection.main.head], info).toEqual([sel.anchor, sel.head])
    }

    it('Tab then Shift+Tab over code lines gives back the text and the selection, a blank line’s spaces aside', () => {
        // "Tab / Shift+Tab: Code indentation, never left of the fence column: at a caret Tab inserts the
        // indent and Shift+Tab removes one; over a selection every touched line indents or outdents and
        // the selection stays on its text". At a caret in a line's indentation the two are inverse;
        // mid-line Tab inserts at the caret and Shift+Tab takes from the line's start, as in VS Code.
        // "Tab there [an empty line short of the column] indents the code one level from the fence
        // column, as it would on the padded line", so a blank line may come back padded. Left out: a
        // selection holding a code sample's fence-like line, which the next property covers.
        fc.assert(
            fc.property(scenarioArb, fc.boolean(), (s, inIndent) => {
                const placed = place({ ...s, where: inIndent ? 'code' : s.where }, true)
                if (placed) roundTrip(placed)
            }),
            fuzz(500),
        )
    })

    /** A four-backtick block holding a three-backtick sample, with code lines before and after the sample. */
    const sampleBlockArb: fc.Arbitrary<BlockSpec> = fc
        .record({
            info: fc.constantFrom('', 'md'),
            before: fc.array(codeLineArb, { minLength: 1, maxLength: 2 }),
            after: fc.array(codeLineArb, { minLength: 1, maxLength: 2 }),
            bareBlanks: fc.boolean(),
        })
        .map(({ info, before, after, bareBlanks }) => ({ run: '````', info, code: [...before, { sample: true as const, pad: 2 }, ...after], bareBlanks }))

    it('Tab and Shift+Tab over a range holding one fence of a code sample’s inner pair, and code outside the pair, change nothing', () => {
        // "Tab, Shift+Tab and Alt+↑/↓ over a range are refused where they would move one inner fence
        // without its partner." The owner's answer (2026-11-16): both keys refuse the whole range, as
        // Shift+Tab did. Tab used to indent the other lines and leave the fence where it was.
        fc.assert(
            fc.property(docArb, docArb, sampleBlockArb, fc.boolean(), fc.boolean(), fc.boolean(), fc.nat(), fc.nat(), (head, tail, block, inBullet, closer, backwards, a, b) => {
                const sampleItem: Item = inBullet ? { kind: 'bullet', step: 0, task: false, text: 'Garden', block, onLine: false, soft: null } : { kind: 'proseBlock', block }
                const lines = render([...head, sampleItem, ...tail])
                const blocks = fencedBlocks(lines)
                // An inner pair with code of the sample both before and after it (the generated one always has).
                const enclosing = (p: FencedBlockRange) => blocks.filter((o) => o.start < p.start && p.end < o.end).sort((x, y) => y.start - x.start)[0]
                const inner = blocks.find((p) => {
                    const o = enclosing(p)
                    return o && p.start - o.start >= 2 && o.end - p.end >= 2
                })
                if (!inner) return
                const outer = enclosing(inner)
                // Holding the closer: from inside the pair to a line after it. Holding the opener: from a line before it into the pair.
                const [first, last] = closer
                    ? [inner.start + 1 + (a % (inner.end - inner.start)), inner.end + 1 + (b % (outer.end - inner.end - 1))]
                    : [outer.start + 1 + (a % (inner.start - outer.start - 1)), inner.start + (b % (inner.end - inner.start))]
                const editor = editorFixture('|' + lines.join('\n'))
                const from = editor.state.doc.line(first + 1).from
                const to = editor.state.doc.line(last + 1).to
                for (const key of ['Tab', 'Shift-Tab']) {
                    editor.select(backwards ? to : from, backwards ? from : to)
                    const before = editor.fixture()
                    expect(editor.key(key), `${key} over ${JSON.stringify(before)} was not consumed`).toBe(true)
                    expect(editor.fixture(), `${key} over ${JSON.stringify(before)}`).toBe(before)
                }
            }),
            fuzz(300),
        )
    })

    // Was TAB_INDENTED_CODE: Shift+Tab took up to two CHARACTERS from the start of a code line, so on a
    // line indented with a tab it took the tab and a space, or, in a bullet's block, a space of the
    // structure left of the fence column. Shrunk then: "```\n\t|return 1\n```" Tab, Shift+Tab gave
    // "```\n |return 1\n```". It now takes the spaces nearest the code, or one tab (`codeOutdentRange`).
    it('Tab then Shift+Tab over a tab-indented code line gives back the text', () => {
        // The rule sentences of the property above, over code whose own indentation is a tab, as code
        // pasted from a tab-indented file keeps it ("Code and YAML are never normalised").
        fc.assert(
            fc.property(scenarioArb, fc.boolean(), (s, inIndent) => {
                const placed = place({ ...s, where: inIndent ? 'code' : s.where }, true)
                if (placed) roundTrip(placed, true) // only placements on a tab-indented line
            }),
            fuzz(500),
        )
    })

    // Was TAB_INDENTED_CODE, too: Mod+Enter on a soft line above a bullet's block carried the block out
    // to the margin and wrote a code line's tab out as a space. Shrunk then:
    // "- a\n  |soft\n  ```\n  \treturn 1\n  ```" gave "- a\n|soft\n```\n return 1\n```". `shiftLines` now
    // takes characters off the line's start and leaves the rest as written.
    it('a block carried out by Mod+Enter keeps a tab-indented code line’s own indentation', () => {
        // "A body line keeps its indentation (CommonMark)": past the fence column it is the code's own.
        fc.assert(
            fc.property(wordArb, fc.array(fc.constantFrom('\treturn 1', '\t\twater(beans)', 'return 1'), { minLength: 1, maxLength: 3 }), (soft, code) => {
                const before = ['- water the beans', `  ${soft}`, '  ```', ...code.map((c) => `  ${c}`), '  ```']
                const editor = editorFixture('|' + before.join('\n'))
                editor.select(editor.state.doc.line(2).from + 2)
                const fixture = editor.fixture()
                editor.key('Mod-Enter')
                const lines = editor.text().split('\n')
                const blocks = fencedBlocks(lines)
                expect(blocks.length, JSON.stringify(editor.fixture())).toBe(1)
                const got = lines.slice(blocks[0].start + 1, blocks[0].end).map((l) => codeLineText(l, blocks[0].fenceColumn))
                expect(got, `${JSON.stringify(fixture)} gave ${JSON.stringify(editor.fixture())}`).toEqual(code)
            }),
            fuzz(100),
        )
    })
})

/** A fragment of code, two to four lines, with its own indentation (spaces, or tabs), maybe CRLF. */
const fragmentArb = fc
    .record({
        lines: fc.array(fc.record({ depth: fc.constantFrom(0, 0, 1, 2), text: fc.constantFrom('return 1', 'if x:', 'water(beans)', '- x', '# c', '') }), { minLength: 2, maxLength: 4 }),
        base: fc.constantFrom(0, 2, 4),
        unit: fc.constantFrom('  ', '    ', '\t'),
        crlf: fc.boolean(),
    })
    .map(({ lines, base, unit, crlf }) => {
        const lead = unit === '\t' ? '\t'.repeat(base / 2) : ' '.repeat(base)
        const text = lines.map((l) => (l.text === '' ? '' : lead + unit.repeat(l.depth) + l.text))
        return { lines: text, pasted: text.join(crlf ? '\r\n' : '\n') }
    })

/**
 * Paste `fragment` over the placed selection and check what the clamp promises: "Inside a fenced
 * block, the clamp: every line after the first is indented to the fence column, the fragment's own
 * common indentation stripped, so column 0 of the fragment reads as column 0 of the code and no pasted
 * line can dissolve the block", and "a fragment of one line or several pasted onto an empty code line
 * lands at the fence column with its own indentation kept". "One paste is one undo step."
 */
function checkCodePaste(placed: Placed, fragment: { lines: string[]; pasted: string }): void {
    const { editor, block } = placed
    const { state } = editor
    const sel = state.selection.main
    // A paste onto a code sample's fence line edits that fence by the person's own hand.
    for (let n = state.doc.lineAt(sel.from).number; n <= state.doc.lineAt(sel.to).number; n++) if (fenceLineInfo(state.doc.line(n).text)) return
    const fixture = editor.fixture()
    const blocks = analysisFor(state).fencedBlocks
    const was = blockWords(editor.text().split('\n'), blocks)
    const fromLine = state.doc.lineAt(sel.from)
    const toLine = state.doc.lineAt(sel.to)
    const startCol = sel.from - fromLine.from
    const prefix = fromLine.text.slice(0, startCol)
    const rest = toLine.text.slice(sel.to - toLine.from)
    // The innermost block holding the caret's line sets the column the fragment lands at.
    const column = innermost(blocks, fromLine.number - 1)?.fenceColumn ?? block.fenceColumn
    editor.paste(fragment.pasted)
    const after = editor.text().split('\n')
    const info = `paste ${JSON.stringify(fragment.pasted)} at ${JSON.stringify(fixture)} gave ${JSON.stringify(editor.fixture())}`
    const now = blockWords(after, analysisFor(editor.state).fencedBlocks)
    expect(now.outer, info).toEqual(was.outer)
    expect(within(was.all, now.all), info).toBe(true)
    // The fragment's lines, less their common indentation (in characters, as the clamp counts).
    const indents = fragment.lines.filter((l) => l.trim() !== '').map((l) => l.length - l.trimStart().length)
    const common = indents.length ? Math.min(...indents) : 0
    const own = fragment.lines.map((l) => l.slice(Math.min(common, l.length - l.trimStart().length)))
    const at = fromLine.number - 1
    // The first line lands at the caret, a blank line short of the column padded out to it first.
    const lead = startCol < column && fromLine.text.trim() === '' ? prefix + ' '.repeat(column - startCol) : prefix
    expect(after[at], info).toBe(lead + own[0])
    for (let k = 1; k < own.length; k++) expect(after[at + k], info).toBe(' '.repeat(column) + own[k] + (k === own.length - 1 ? rest : ''))
    editor.key('Mod-z')
    expect(editor.fixture(), info).toBe(fixture)
}

describe('a paste into code', { timeout: 30_000 }, () => {
    it('a multi-line paste onto a code line keeps the block and the fragment’s relative indentation, as one undo step', () => {
        // checkCodePaste names the rule sentences.
        fc.assert(
            fc.property(scenarioArb, fragmentArb, (s, fragment) => {
                const placed = place(s, true)
                if (placed) checkCodePaste(placed, fragment)
            }),
            fuzz(300),
        )
    })

    // Was PROSE_BLOCK_PASTE: in a prose block (fence column 0) the fragment's common indentation was
    // kept, where a bullet's block strips it. Shrunk then: "```\n|return 1\n```" pasting
    // "    return 1\n    return 1" gave "```\n    return 1\n    return 1|return 1\n```". The clamp now
    // strips it wherever the paste lands in code.
    it('a multi-line paste onto a code line of a prose block strips the fragment’s common indentation too', () => {
        fc.assert(
            fc.property(scenarioArb, fragmentArb, (s, fragment) => {
                const placed = place(s, true)
                if (!placed || placed.block.fenceColumn !== 0) return
                checkCodePaste(placed, fragment)
            }),
            fuzz(300),
        )
    })
})

describe('a longer fence with no closer', { timeout: 30_000 }, () => {
    /** The items with every block three backticks long and no code sample in it. */
    const threeOnly = (items: Item[]): Item[] =>
        items.map((item) => {
            const block = 'block' in item ? item.block : null
            if (!block) return item
            return { ...item, block: { ...block, run: '```', code: block.code.filter((c) => !('sample' in c)) } } as Item
        })

    it('a four-backtick fence with no closer holds every three-backtick block at its column below it as text, until its closer arrives', () => {
        // The owner's answer (2026-11-16): intended. "A shorter same-column fence is literal content",
        // so a three-backtick block below an open four-backtick fence is the open fence's content, and
        // "an unterminated opener yields no block". A four-backtick fence is how a sample holds
        // three-backtick blocks, and its closer turns the whole run into one block.
        fc.assert(
            fc.property(docArb, (items) => {
                const lines = ['````', ...render(threeOnly(items))]
                expect(fencedBlocks(lines).filter((b) => b.fenceColumn === 0), JSON.stringify(lines)).toEqual([])
                const editor = editorFixture('|' + lines.join('\n'))
                expect(analysisFor(editor.state).fencedBlocks.filter((b) => b.fenceColumn === 0), JSON.stringify(lines)).toEqual([])
                const closed = [...lines, '````']
                const outer = fencedBlocks(closed).filter((b) => b.fenceColumn === 0)
                expect(outer, JSON.stringify(closed)).toEqual([{ start: 0, end: closed.length - 1, fenceColumn: 0 }])
            }),
            fuzz(300),
        )
    })
})

describe('fence completion', { timeout: 30_000 }, () => {
    // Found by "a key keeps the own indentation of every code line it was not pressed on" under
    // EDITOR_FUZZ_SEED=77 at 6000 runs, shrunk to `- water the beans\n  ```|\n  return 1\n  ```\n  ```\n```\n````
    // with Enter. Three fences of one kind in a row read as an opener above a block, not a block above a
    // stray, so Enter on the first completes it even with code under it: the code is left below the new
    // block and the old closer pairs with the stray. The owner's answer (2026-11-17): intended. Someone
    // with the caret on that fence knows Enter does not wrap the text below.
    it('Enter on the opener of a block holding code, a stray fence just below it, completes the opener as a new block', () => {
        for (const [before, after] of [
            ['- a\n  ```|\n  return 1\n  ```\n  ```', '- a\n  ```\n  |\n  ```\n  return 1\n  ```\n  ```'],
            ['```|\nreturn 1\n```\n```', '```\n|\n```\nreturn 1\n```\n```'],
        ]) {
            const editor = editorFixture(before)
            editor.key('Enter')
            expect(editor.fixture(), before).toBe(after)
            // The new pair is a block, and the old closer pairs with the stray below it.
            const column = before.startsWith('-') ? 2 : 0
            const first = before.startsWith('-') ? 1 : 0
            expect(analysisFor(editor.state).fencedBlocks, before).toEqual([
                { start: first, end: first + 2, fenceColumn: column },
                { start: first + 4, end: first + 5, fenceColumn: column },
            ])
        }
    })

    it('Enter and Shift+Enter inside the backticks or info string of a fence no block pairs act as at the line end, never splitting it', () => {
        // "Enter / Shift+Enter (inside a fence line's backticks): as at the line end, never splitting
        // the fence." The owner's answer (2026-11-16): a fence with no closer, or a stray, too. On an
        // opener with no closer, Enter there completes it as Enter at its end does.
        fc.assert(
            fc.property(strayDocArb, fc.nat(), fc.nat(), fc.constantFrom('Enter', 'Shift-Enter'), (items, pick, offset, key) => {
                const lines = render(items)
                const probe = editorFixture('|' + lines.join('\n'))
                const blocks = analysisFor(probe.state).fencedBlocks
                const lone = lines.flatMap((l, i) => (fenceLineInfo(l) && !blocks.some((b) => i >= b.start && i <= b.end) ? [i] : []))
                if (lone.length === 0) return
                const i = lone[pick % lone.length]
                const f = fenceLineInfo(lines[i])!
                const textEnd = lines[i].trimEnd().length
                // Strictly past the first backtick and before the end of the line's text.
                const col = f.col + 1 + (offset % (textEnd - f.col - 1))
                const inside = editorFixture('|' + lines.join('\n'))
                inside.select(inside.state.doc.line(i + 1).from + col)
                const atEnd = editorFixture('|' + lines.join('\n'))
                atEnd.select(atEnd.state.doc.line(i + 1).to)
                const before = inside.fixture()
                inside.key(key)
                atEnd.key(key)
                expect(inside.fixture(), `${key} in ${JSON.stringify(before)}`).toBe(atEnd.fixture())
            }),
            fuzz(500),
        )
    })

    /** An opener to type: prose or a bullet's, bare, with an info string, or four backticks; a bullet's with a space after its marker. */
    const openerArb = fc.record({
        bullet: fc.boolean(),
        spaced: fc.boolean(),
        run: fc.constantFrom('```', '````'),
        info: fc.constantFrom('', 'py'),
    })

    type Opener = { bullet: boolean; spaced: boolean; run: string; info: string }

    /**
     * Type `opener` a character at a time on an empty line inserted before line `k` (a bullet's after
     * its marker), press Enter, and check the completion: the text, and the blocks the editor draws,
     * every block of `lines` kept and the new one added. Returns early, checking nothing, where the
     * rules promise no completion (see the comments).
     */
    function completeTyped(lines: string[], k: number, opener: Opener): void {
        const blocks = fencedBlocks(lines)
        const head = lines.slice(0, k)
        const tail = lines.slice(k)
        const lead = opener.bullet ? `-${opener.spaced ? '  ' : ' '}` : ''
        const editor = editorFixture('|' + [...head, lead, ...tail].join('\n'))
        editor.select(editor.state.doc.line(k + 1).to)
        for (const ch of opener.run + opener.info) editor.type(ch)
        const typed = editor.fixture()
        // A stray fence that pairs with the typed one (above it, or a closer below it) makes a complete
        // block of it: "Completion is refused when a complete block already accounts for the line". One
        // that takes an existing block's fence is the swallow the rule completes. So is a document every
        // fence of which is now in a block, the typed one included, or one where the typed opener pairs
        // and takes no block's fence (`opensWithoutTakingAFence`): a stray elsewhere says nothing about
        // it. Whether Enter then completes it is the tally's answer, which the rule rows pin.
        const pairedBefore = new Set(blocks.flatMap((b) => [b.start, b.end]).map((i) => (i >= k ? i + 1 : i)))
        // The typed line read as Enter reads it: `-  \`\`\`` is the opener it looks like, and "a closer
        // already below a spaced opener" stops the completion.
        const typedLines = editor.text().split('\n').map((l, i) => (i === k ? tidiedFenceLine(l) : l))
        const typedBlocks = fencedBlocks(typedLines)
        const own = typedBlocks.find((b) => b.start === k || b.end === k)
        if (own && !pairedBefore.has(own.start === k ? own.end : own.start)) return
        if (opensWithoutTakingAFence(typedLines, k)) return
        const column = opener.bullet ? 2 : 0
        const tidied = opener.bullet ? `- ${opener.run}${opener.info}` : `${opener.run}${opener.info}`
        const completed = [...head, tidied, ' '.repeat(column), ' '.repeat(column) + opener.run, ...tail]
        // Under a dangling longer fence at its column the completed pair is that fence's content, "a
        // shorter same-column fence is literal content", and no block shows. The rules do not say whether
        // that is wanted.
        if (!fencedBlocks(completed).some((b) => b.start === k && b.end === k + 2)) return
        editor.key('Enter')
        const info = `Enter at ${JSON.stringify(typed)} gave ${JSON.stringify(editor.fixture())}`
        expect(editor.text().split('\n'), info).toEqual(completed)
        // The new block, and every block that was there still there, three lines on. Completing an
        // opener under a dangling longer one can free blocks that fence held as content, too.
        const shift = (b: FencedBlockRange) => (b.start >= k ? { ...b, start: b.start + 3, end: b.end + 3 } : b)
        const expected = [...blocks.map(shift), { start: k, end: k + 2, fenceColumn: column }].map(blockKey)
        const drawn = analysisFor(editor.state).fencedBlocks.map(blockKey)
        expect(within(expected, drawn), `${info}: drew ${JSON.stringify(drawn)}, expected ${JSON.stringify(expected)}`).toBe(true)
    }

    /** The gaps of `lines` an opener can be typed in on a line of its own: before a line at the margin, outside every block. */
    function marginGaps(lines: string[]): number[] {
        const blocks = fencedBlocks(lines)
        return Array.from({ length: lines.length + 1 }, (_, k) => k).filter((k) => (k === lines.length || !/^\s/.test(lines[k])) && !blocks.some((b) => b.start < k && k <= b.end))
    }

    it('Enter after typing an opener adds exactly one balanced block of its length, and every other block stays', () => {
        // "Enter at the end of a fence line completes it: info-string default (if configured), an
        // empty middle line at the fence column, and a balanced closer (a 4-backtick opener gets a
        // 4-backtick closer". "A fence typed above an existing block ... the new opener still
        // completes and the block below keeps its fences". "Spaces after the bullet marker ... do not
        // stop it: `-  ``` ` ... Enter completes it and drops the spaces".
        fc.assert(
            fc.property(fc.oneof(docArb, strayDocArb), fc.nat(), openerArb, (items, pick, opener) => {
                const lines = render(items)
                const gaps = marginGaps(lines)
                completeTyped(lines, gaps[pick % gaps.length], opener)
            }),
            fuzz(500),
        )
    })

    // Was PENDING_ABOVE_BLOCK: a prose opener typed directly above a prose block, in a document that
    // holds a stray fence elsewhere, stayed held pending after Enter completed it, and the editor paired
    // the new closer with the old block's opener. Shrunk then: "- water the beans\n  ```\n```\n```" with
    // "```" typed on a new first line and Enter. The release check (`pairsOnItsOwn`) now compares the
    // fences that pair, not the blocks.
    it('Enter after typing a prose opener in a document with a stray fence draws the new block and keeps the old ones', () => {
        // "It is released too once it pairs without taking any block's fence, as when Enter completes
        // it: a stray fence elsewhere keeps the document from ever balancing, and the block someone had
        // just closed stayed drawn as text."
        fc.assert(
            fc.property(strayDocArb, fc.nat(), openerArb, (items, pick, opener) => {
                const lines = render(items)
                const gaps = marginGaps(lines)
                completeTyped(lines, gaps[pick % gaps.length], { ...opener, bullet: false })
            }),
            fuzz(500),
        )
    })

    /** Enter or Shift+Enter on a fence line of a block, at its end or between two of its backticks; what the key gave. */
    function enterOnFence(lines: string[], block: FencedBlockRange, closer: boolean, inside: number, key: string): { info: string; after: string[]; blocks: readonly FencedBlockRange[] } {
        const index = closer ? block.end : block.start
        const f = fenceLineInfo(lines[index])!
        const editor = editorFixture('|' + lines.join('\n'))
        const line = editor.state.doc.line(index + 1)
        editor.select(line.from + (inside % 2 === 0 ? line.length : f.col + 1 + (inside % (f.len - 1))))
        const fixture = editor.fixture()
        editor.key(key)
        return { info: `${key} at ${JSON.stringify(fixture)} gave ${JSON.stringify(editor.fixture())}`, after: editor.text().split('\n'), blocks: analysisFor(editor.state).fencedBlocks }
    }

    it('Enter on a fence line of a complete block never adds another pair', () => {
        // "Completion is refused when a complete block already accounts for the line ... as its
        // opener, whether the block is empty or holds content, as its closer, or as a shorter fence
        // that is its content — so pressing Enter there never generates another pair". "Enter /
        // Shift+Enter (inside a fence line's backticks): As at the line end, never splitting the fence".
        // Documents with no stray fences, so every block is one the editor wrote (a stray above a block
        // pairs with its opener, and Enter there completes the stray by design).
        fc.assert(
            fc.property(docArb, fc.nat(), fc.boolean(), fc.nat(), fc.constantFrom('Enter', 'Shift-Enter'), (items, pick, closer, inside, key) => {
                const lines = render(items)
                const blocks = fencedBlocks(lines)
                if (blocks.length === 0) return
                const { info, after, blocks: now } = enterOnFence(lines, blocks[pick % blocks.length], closer, inside, key)
                expect(fenceLineCount(after), info).toBe(fenceLineCount(lines))
                expect(blockWords(after, now), info).toEqual(blockWords(lines, blocks))
            }),
            fuzz(300),
        )
    })

    // Was SAME_COLUMN_SAMPLE: Enter at the end of the opener of a complete four-backtick block that
    // holds a three-backtick sample at the block's own column added a second closer. Shrunk then:
    // "````|\n```js\nreturn 1\n```\n````" + Enter gave "````\n|\n````\n```js\nreturn 1\n```\n````".
    // `isUnterminatedOpener` tallied the sample's fences, which pair as a block once the opener is set
    // aside; it now tallies only blocks opened at the candidate's column by a run of its length.
    it('Enter on the opener of a four-backtick block holding a three-backtick sample at its column never adds another pair', () => {
        fc.assert(
            fc.property(fc.array(itemArb(blockArb([0])), { minLength: 1, maxLength: 5 }), fc.nat(), fc.nat(), (items, pick, inside) => {
                const lines = render(items)
                const blocks = fencedBlocks(lines).filter((b) => lines.slice(b.start + 1, b.end).some((l) => fenceLineInfo(l)?.col === b.fenceColumn))
                if (blocks.length === 0) return
                const block = blocks[pick % blocks.length]
                const { info, after, blocks: now } = enterOnFence(lines, block, false, inside, 'Enter')
                expect(fenceLineCount(after), info).toBe(fenceLineCount(lines))
                expect(blockWords(after, now), info).toEqual(blockWords(lines, fencedBlocks(lines)))
            }),
            fuzz(300),
        )
    })
})

describe('fence lines the editor writes on its own', { timeout: 30_000 }, () => {
    // Was CARET_AFTER_CLOSER_SNAP: two edits at a closer left the caret at column 0 of the closer, left
    // of the fence column. A space typed at the closer's fence column nudges it right, and Mod+Delete at
    // its end joins the blank soft line's spaces onto it; the source guard writes the closer back, and
    // replaced the whole line, which carried the caret to its start. Shrunk then:
    // "- water the beans\n  ```\n  |```" typing " " gave "- water the beans\n  ```\n|  ```". The guard
    // now changes only the characters that differ.
    it('a space typed at a closer’s fence column, or Mod+Delete at its end over a blank line, leaves the caret at or right of the column', () => {
        // "The caret clamp holds inside blocks too: the caret cannot rest left of the fence column."
        fc.assert(
            fc.property(docArb, fc.nat(), fc.constantFrom('space', 'Mod-Delete'), (items, pick, trigger) => {
                const lines = render(items)
                const blocks = fencedBlocks(lines).filter((b) => b.fenceColumn > 0)
                if (blocks.length === 0) return
                const block = blocks[pick % blocks.length]
                const editor = editorFixture('|' + lines.join('\n'))
                const closer = editor.state.doc.line(block.end + 1)
                if (trigger === 'space') {
                    editor.select(closer.from + block.fenceColumn)
                    editor.type(' ')
                } else {
                    // The blank soft line comes from Shift+Enter at the closer's end, and the caret goes
                    // back there (ArrowLeft at the new line's clamp, where that is the closer's column).
                    editor.select(closer.to)
                    editor.key('Shift-Enter')
                    editor.select(closer.to)
                    editor.key('Mod-Delete')
                }
                const line = editor.state.doc.lineAt(editor.head())
                expect(editor.head() - line.from, `${trigger} at ${JSON.stringify(lines.join('\n'))} gave ${JSON.stringify(editor.fixture())}`).toBeGreaterThanOrEqual(block.fenceColumn)
            }),
            fuzz(100),
        )
    })

    // Was TOLERANT_STRAYS: the source guard re-paired two stray fences that no edit touched. Its
    // tolerant scan read a prose fence at the margin and a fence of the same length one to three
    // columns in further down as a pair with a nudged closer, and any edit between them moved the
    // lower one to the margin. Shrunk then: "```\n- water the beans|\n ```" typing "x" gave
    // "```\n- water the beansx|\n```". A pair the strict scan did not hold before the edit is now
    // repaired only where the edit wrote or moved its closer.
    it('an edit between two stray fences never moves either', () => {
        // "This scoping is why stray or orphaned backticks elsewhere in a document can never interfere
        // with a block: fences outside the block simply do not count toward its balance."
        fc.assert(
            fc.property(docArb, fc.constantFrom('```', '````'), fc.constantFrom(1, 2, 3), fc.nat(), (items, run, nudge, pick) => {
                const body = render(items)
                const lines = [run, ...body, ' '.repeat(nudge) + run]
                // Only where the strict scan leaves both strays unpaired, and the guard's tolerant scan pairs them.
                if (fencedBlocks(lines).some((b) => b.start === 0 || b.end === lines.length - 1)) return
                if (!fencedBlocks(lines, 3).some((b) => b.start === 0 && b.end === lines.length - 1)) return
                const editor = editorFixture('|' + lines.join('\n'))
                // A character typed at the end of a line between them that is not a fence line.
                const between = body.map((_, i) => i + 1).filter((i) => !fenceLineInfo(lines[i]))
                if (between.length === 0) return
                editor.select(editor.state.doc.line(between[pick % between.length] + 1).to)
                const fixture = editor.fixture()
                editor.type('x')
                const after = editor.text().split('\n')
                expect(after[after.length - 1], `${JSON.stringify(fixture)} gave ${JSON.stringify(editor.fixture())}`).toBe(lines[lines.length - 1])
            }),
            fuzz(300),
        )
    })

    // Was CARRIED_UNDER_LONGER_STRAY: Mod+Enter on a bullet's soft line carried the rest of the block
    // out to the margin, and below a longer fence with no closer there the carried code block became
    // that fence's content. Shrunk then: "````\n- water the beans\n  |Garden\n  ```\n  return 1\n  ```"
    // gave "````\n- water the beans\n|Garden\n```\nreturn 1\n```", with no block drawn. The key is now
    // refused there (`keepsStructure`: a block carried away whole lands as a block).
    it('Mod+Enter that carries a code block out to the margin never loses it', () => {
        // "Mod+Enter: Leave the block", "a trailing fence leaves dedented as a unit", and Mod+Enter is
        // "refused where the fence it carries out would pair with another fence at the margin".
        fc.assert(
            fc.property(fc.constantFrom('````', '````js', '`````'), wordArb, fc.array(codeLineArb, { maxLength: 3 }), (above, soft, code) => {
                const lines = [above, '- water the beans', `  ${soft}`, '  ```', ...codeLines({ run: '```', info: '', code, bareBlanks: false }, 2), '  ```', '- dig the bed']
                const editor = editorFixture('|' + lines.join('\n'))
                editor.select(editor.state.doc.line(3).from + 2)
                const fixture = editor.fixture()
                editor.key('Mod-Enter')
                const info = `${JSON.stringify(fixture)} gave ${JSON.stringify(editor.fixture())}`
                expect(analysisFor(editor.state).fencedBlocks.length, info).toBe(fencedBlocks(lines).length)
            }),
            fuzz(100),
        )
    })

    // Was TIDIED_STRAY: tidy on leave stripped the one to three leading spaces of a prose line, and on
    // a stray fence line that moved it onto column 0, where it paired with the next block's opener.
    // Shrunk then: "|  ```\n```\n```" with the caret moved to the second line gave "```\n|```\n```".
    // A fence line now keeps its leading spaces.
    it('the caret leaving a stray fence line never re-pairs the blocks', () => {
        // "This scoping is why stray or orphaned backticks elsewhere in a document can never interfere
        // with a block", and tidy on leave never touches fenced code. Moving the caret is no edit of a
        // fence by the person's own hand.
        fc.assert(
            fc.property(docArb, fc.constantFrom(' ', '  ', '   '), fc.constantFrom('```', '````'), (items, spaces, run) => {
                const lines = [`${spaces}${run}`, ...render(items)]
                const editor = editorFixture('|' + lines.join('\n'))
                const fixture = editor.fixture()
                editor.select(editor.state.doc.line(Math.min(2, lines.length)).from)
                expect(analysisFor(editor.state).fencedBlocks.map(blockKey).sort(), `${JSON.stringify(fixture)} gave ${JSON.stringify(editor.fixture())}`).toEqual(fencedBlocks(lines).map(blockKey).sort())
            }),
            fuzz(300),
        )
    })
})

describe('the Derived Index agrees with the editor', { timeout: 30_000 }, () => {
    /** Every task-shaped bullet line: where a checkbox is drawn, if the editor shows a task there. */
    const taskLines = (lines: readonly string[]) => lines.flatMap((l, i) => (/^\s*- \[[ xX]\] /.test(l) ? [i] : []))

    /** The lines of `text` the Derived Index lists as tasks, and the lines the editor draws a checkbox on. */
    function indexedAndShown(text: string): { indexed: number[]; shown: number[] } {
        const editor = editorFixture('|' + text)
        const shown = taskLines(text.split('\n')).filter((i) => {
            const line = editor.state.doc.line(i + 1)
            return checkboxClick(editor.state, line.from + line.text.indexOf('[')) !== null
        })
        const indexed = deriveDoc(text)
            .tasks.map((t) => t.line)
            .sort((a, b) => a - b)
        return { indexed, shown }
    }

    it('on documents of complete blocks, a task is indexed exactly when the editor shows its checkbox', () => {
        // "The Derived Index asks the same scan (index-derive.ts fencedLines) when it decides whether a
        // `- [ ]` line is a task or a fenced example, so a task is indexed exactly when the editor
        // shows one." The editor shows one where it draws a checkbox to click (task-checkbox.ts).
        fc.assert(
            fc.property(docArb, (items) => {
                const text = render(items).join('\n')
                const { indexed, shown } = indexedAndShown(text)
                expect(indexed, JSON.stringify(text)).toEqual(shown)
            }),
            fuzz(300),
        )
    })

    it('around stray fences, a task is indexed exactly when the editor shows its checkbox', () => {
        // Was CHECKBOX_BY_PARSER: the checkbox followed the CommonMark parse, which closes a stray
        // fence at the next bare closer. Shrunk then: "```\n- [ ] water the beans\n```py\n```". The
        // checkbox now asks the index's own scan (index-derive.ts indexFencedLines).
        fc.assert(
            fc.property(strayDocArb, (items) => {
                const text = render(items).join('\n')
                const { indexed, shown } = indexedAndShown(text)
                expect(indexed, JSON.stringify(text)).toEqual(shown)
            }),
            fuzz(300),
        )
    })

    /** The lines the index lists as tasks and the lines a checkbox is drawn on, in a live editor. */
    function agreement(editor: HeadlessEditor): { indexed: number[]; shown: number[] } {
        const text = editor.text()
        const shown = taskLines(text.split('\n')).filter((i) => {
            const line = editor.state.doc.line(i + 1)
            return checkboxClick(editor.state, line.from + line.text.indexOf('[')) !== null
        })
        const indexed = deriveDoc(text)
            .tasks.map((t) => t.line)
            .sort((a, b) => a - b)
        return { indexed, shown }
    }

    it('while a fence is typed a backtick at a time and then completed, a task is indexed exactly when the editor shows its checkbox', () => {
        // The owner's answer (2026-11-16): the checkbox follows the index through every step, the
        // fence with no closer yet included. The CommonMark parse ran a half-typed fence on over the
        // tasks below it and hid their checkboxes while the Tasks View still listed them.
        fc.assert(
            fc.property(strayDocArb, fc.nat(), fc.constantFrom('```', '````', '```py'), fc.boolean(), (items, at, run, bullet) => {
                const lines = render(items)
                const k = at % (lines.length + 1)
                // An empty line before line k: a soft line of the bullet above at its content column, or a margin line.
                const above = lines[k - 1] ?? ''
                const column = bullet && /^\s*- /.test(above) ? above.indexOf('-') + 2 : 0
                const editor = editorFixture('|' + [...lines.slice(0, k), ' '.repeat(column), ...lines.slice(k)].join('\n'))
                editor.select(editor.state.doc.line(k + 1).to)
                const check = (moment: string) => {
                    const { indexed, shown } = agreement(editor)
                    expect(shown, `${moment}: ${JSON.stringify(editor.fixture())}`).toEqual(indexed)
                }
                check('before typing')
                for (const ch of run) {
                    editor.type(ch)
                    check(`after typing ${JSON.stringify(ch)}`)
                }
                editor.key('Enter')
                check('after Enter')
            }),
            fuzz(300),
        )
    })

    it('the Derived Index reads a CRLF file’s tasks as it reads the same file with LF line ends', () => {
        // The index derives from the stored text, which another tool may write with CRLF; the editor
        // reads both the same, so the index must too.
        fc.assert(
            fc.property(strayDocArb, (items) => {
                const text = render(items).join('\n')
                const lf = deriveDoc(text).tasks.map((t) => t.line)
                const crlf = deriveDoc(text.replace(/\n/g, '\r\n')).tasks.map((t) => t.line)
                expect(crlf, JSON.stringify(text)).toEqual(lf)
            }),
            fuzz(300),
        )
    })
})





