/**
 * Property tests over an editor that shows one part of a task (`shown-range.ts`, ADR 0170): what
 * must hold after any run of the person's keys on any task, not only the rows in
 * `outliner-keymap.rules.test.ts`.
 *
 * - The lines outside the part never change under the person's own keys.
 * - A refused key leaves the document exactly as it was.
 * - The notice tells the truth (`edit-refused.ts`): the edge a refusal names is what the same key
 *   would have done in an editor showing the whole document. A join above is a key that would have
 *   joined a line onto the line above the part, a move out one that would have taken a shown line out
 *   of the part, and so on.
 * - The fold chevron is drawn only for a shown bullet, over a shown row, and there for the bullet a
 *   whole-document editor would draw it for (`augmentations/fold-controls.ts`).
 */
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { chevronLine } from './augmentations/fold-controls'
import { type EditRefusal, type ShownRangeEdge } from './edit-refused'
import { anchoredLine, anchorLine, lineAnchor } from './line-anchor'
import { shownRange, shownRangeIn } from './shown-range'
import { type TaskPart, taskPartRange } from './task-part-range'
import { collectRefusals, editorFixture, type HeadlessEditor } from './testing/editor-state-fixture'

/**
 * A fixed seed keeps the suite deterministic. To hunt, run with `EDITOR_FUZZ_SEED=<n>` and
 * `EDITOR_FUZZ_RUNS=<n>`; a failure prints the seed and path, and its case then belongs in the rules
 * test as a row.
 */
function fuzz(runs: number): fc.Parameters<unknown> {
    const seed = process.env.EDITOR_FUZZ_SEED
    return { numRuns: Number(process.env.EDITOR_FUZZ_RUNS ?? runs), seed: seed === undefined ? 20261119 : Number(seed) }
}

// ── Generators ───────────────────────────────────────────────────────────────────────────────

/** A task under a heading bullet, with a description, maybe comments, and maybe lines after them. */
interface TaskDocument {
    /** Bullets under the task before any Comments bullet: each nested one level, or two (a child). */
    description: Array<{ child: boolean }>
    /** Comments under the Comments bullet, or null for a task without one. */
    comments: number | null
    /** Lines nested under the task after the Comments block: its additional context. */
    context: number
    /** A sibling task after this one, so the line after a part is sometimes a task. */
    sibling: boolean
}

const taskDocument: fc.Arbitrary<TaskDocument> = fc.record({
    description: fc.array(fc.record({ child: fc.boolean() }), { minLength: 0, maxLength: 3 }),
    comments: fc.option(fc.integer({ min: 1, max: 2 }), { nil: null }),
    context: fc.integer({ min: 0, max: 2 }),
    sibling: fc.boolean(),
})

/**
 * The document's text. Every line's words are its own (`d0`, `c1`, `x0`), so a line can be found
 * again after a key moved it, and a line that is no longer whole can be told from one that moved.
 */
function render(task: TaskDocument): string {
    const lines = ['- [[Garden]]', '  - [ ] Build the shed']
    task.description.forEach(({ child }, i) => lines.push(i > 0 && child ? `      - d${i}` : `    - d${i}`))
    if (task.comments !== null) {
        lines.push('    - Comments')
        for (let i = 0; i < task.comments; i++) lines.push(`      - c${i}`)
        for (let i = 0; i < task.context; i++) lines.push(`    - x${i}`)
    }
    if (task.sibling) lines.push('  - [ ] Paint the fence')
    lines.push('- Kitchen')
    return lines.join('\n')
}

/** The parts the document has: the Task Editor shows an editor only for a part with lines. */
function partsOf(task: TaskDocument): TaskPart[] {
    const parts: TaskPart[] = []
    if (task.description.length > 0) parts.push('description')
    if (task.comments !== null) parts.push('comments')
    if (task.comments !== null && task.context > 0) parts.push('additionalContext')
    return parts
}

/** The keys that reach the part's edges, and some that move the caret between them. */
const KEYS = ['Backspace', 'Delete', 'Tab', 'Shift-Tab', 'Alt-ArrowUp', 'Alt-ArrowDown', 'Enter', 'Home', 'End', 'ArrowUp', 'ArrowDown', 'Mod-a'] as const

/** Where the caret starts: which shown line (a fraction through the part), and at its start or end. */
const caret = fc.record({ line: fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), atEnd: fc.boolean() })

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

/** An editor showing `part` of the task on line 2 of `text`, and every refusal it dispatches. */
function showing(text: string, part: TaskPart): { editor: HeadlessEditor; refusals: EditRefusal[] } {
    const editor = editorFixture(`|${text}`, { extensions: [lineAnchor(), shownRange(taskPartRange(part))] })
    editor.dispatch(editor.state.update({ effects: anchorLine.of(editor.state.doc.line(2).from) }))
    return { editor, refusals: collectRefusals(editor) }
}

/**
 * Whether the part has gone: everything shown was deleted. The Task Editor then hides the part's
 * editor, so the run's keys stop there (what a key does next is the known gap pinned in
 * `shown-range.test.ts`).
 */
const partGone = (editor: HeadlessEditor) => shownRangeIn(editor.state) === null

/** The texts of the lines outside the part, in order: every line when nothing is shown. */
function hiddenLines(editor: HeadlessEditor): string[] {
    const range = shownRangeIn(editor.state)
    const lines = editor.text().split('\n')
    if (!range) return lines
    const first = editor.state.doc.lineAt(range.from).number - 1
    const last = editor.state.doc.lineAt(range.to).number - 1
    return [...lines.slice(0, first), ...lines.slice(last + 1)]
}

/** The part's lines, from `rangeOf` on the editor's state, as their words alone. */
function partWords(editor: HeadlessEditor, part: TaskPart): string[] {
    const range = taskPartRange(part)(editor.state)
    if (!range) return []
    return editor.state.sliceDoc(range.from, range.to).split('\n').map((line) => line.trim())
}

/**
 * What the key would have done to an editor showing the whole document, read as the edges the notice
 * may name. The key runs on a copy without the guard: same text, same selection, same task. The
 * hidden lines either side of the part are never edited, so each is still a whole line of its own
 * unless the key joined something onto it, or it onto something. An empty line joined onto its
 * neighbour leaves the neighbour as it was, so a lost line that was empty at the part's edge counts
 * as a join at that edge.
 */
function edgesWithoutGuard(editor: HeadlessEditor, part: TaskPart, key: string): ShownRangeEdge[] {
    const range = shownRangeIn(editor.state)
    if (!range) return ['nothing-shown']
    const whole = editorFixture(editor.fixture(), { extensions: [lineAnchor()] })
    whole.dispatch(whole.state.update({ effects: anchorLine.of(whole.state.doc.line(anchoredLine(editor.state)!).from) }))
    const before = editor.text().split('\n')
    const firstShown = editor.state.doc.lineAt(range.from).number - 1
    const lastShown = editor.state.doc.lineAt(range.to).number - 1
    const above = before[firstShown - 1]
    const below = before[lastShown + 1]
    const shown = partWords(editor, part)
    whole.key(key)
    const after = whole.text().split('\n')
    if (after.length < before.length) {
        const edges: ShownRangeEdge[] = []
        if ((above !== undefined && !after.includes(above)) || isEmptyBullet(before[firstShown])) edges.push('join-above')
        if ((below !== undefined && !after.includes(below)) || isEmptyBullet(before[lastShown])) edges.push('join-below')
        return edges.length > 0 ? edges : ['outside']
    }
    // Counted, not looked up: two empty bullets read alike, and a key may take one of them out.
    const kept = partWords(whole, part).map(content)
    for (const line of shown.map(content)) {
        const at = kept.indexOf(line)
        if (at === -1) return ['move-out']
        kept.splice(at, 1)
    }
    return ['outside']
}

/** A line's words without its marker or indentation, so a line moved to another depth reads the same. */
const content = (line: string) => line.trim().replace(/^- ?/, '')

/** A bullet with nothing after its marker. */
const isEmptyBullet = (line: string | undefined) => line !== undefined && /^\s*- ?$/.test(line)

// ── Properties ───────────────────────────────────────────────────────────────────────────────

describe('an editor showing part of a task, under any keys', () => {
    it('never changes a line outside the part, and a refused key changes nothing', () => {
        fc.assert(
            fc.property(
                taskDocument.filter((task) => partsOf(task).length > 0),
                fc.nat(),
                caret,
                fc.array(fc.constantFrom(...KEYS), { minLength: 1, maxLength: 6 }),
                (task, partPick, start, keys) => {
                    const parts = partsOf(task)
                    const part = parts[partPick % parts.length]
                    const { editor, refusals } = showing(render(task), part)
                    placeCaret(editor, start)
                    for (const key of keys) {
                        if (partGone(editor)) break
                        const hidden = hiddenLines(editor)
                        const text = editor.text()
                        const refusedBefore = refusals.length
                        editor.key(key)
                        expect(hiddenLines(editor), `${key} changed a hidden line`).toEqual(hidden)
                        if (refusals.length > refusedBefore) expect(editor.text(), `${key} was refused but changed the text`).toBe(text)
                    }
                },
            ),
            fuzz(300),
        )
    })

    // No key writes whole lines beside the part except the outliner's line move, so the edits a paste,
    // an extension or a later command might write there are made here: whatever the lines are, the
    // hidden lines stay as they were (`changesWithin`, `judgeOwnEdit`).
    it('never changes a line outside the part when whole lines are written beside it', () => {
        fc.assert(
            fc.property(
                taskDocument.filter((task) => partsOf(task).length > 0),
                fc.nat(),
                fc.array(fc.record({ after: fc.boolean(), lines: fc.array(fc.constantFrom('- stray', '  - [ ] other', '    - Comments', '    - more', '      - deeper', '        - deepest', ''), { minLength: 1, maxLength: 3 }) }), { minLength: 1, maxLength: 4 }),
                (task, partPick, inserts) => {
                    const parts = partsOf(task)
                    const { editor } = showing(render(task), parts[partPick % parts.length])
                    for (const { after, lines } of inserts) {
                        const range = shownRangeIn(editor.state)
                        if (!range) break
                        const text = lines.join('\n')
                        // At the start of the hidden line after the part, or the end of the one before it.
                        const at = after ? range.to + 1 : range.from - 1
                        if (at < 0 || at > editor.state.doc.length) continue
                        const hidden = hiddenLines(editor)
                        editor.dispatch(editor.state.update({ changes: { from: at, insert: after ? `${text}\n` : `\n${text}` }, userEvent: 'input.type' }))
                        expect(hiddenLines(editor), `${JSON.stringify(text)} ${after ? 'after' : 'before'} the part`).toEqual(hidden)
                    }
                },
            ),
            fuzz(300),
        )
    })

    it('names the edge the key would have crossed in an editor showing the whole document', () => {
        fc.assert(
            fc.property(
                taskDocument.filter((task) => partsOf(task).length > 0),
                fc.nat(),
                caret,
                fc.array(fc.constantFrom(...KEYS), { minLength: 1, maxLength: 6 }),
                (task, partPick, start, keys) => {
                    const parts = partsOf(task)
                    const part = parts[partPick % parts.length]
                    const { editor, refusals } = showing(render(task), part)
                    placeCaret(editor, start)
                    for (const key of keys) {
                        if (partGone(editor)) break
                        const expected = edgesWithoutGuard(editor, part, key)
                        const refusedBefore = refusals.length
                        editor.key(key)
                        if (refusals.length === refusedBefore) continue
                        const reason = refusals[refusals.length - 1]
                        expect(expected, `${key} on ${JSON.stringify(editor.fixture())}`).toContain(typeof reason === 'string' ? reason : reason.edge)
                    }
                },
            ),
            fuzz(300),
        )
    })
})

describe('the fold chevron in an editor showing part of a task', () => {
    it('is for a shown bullet over a shown row, and there the same bullet as in a whole-document editor', () => {
        fc.assert(
            fc.property(taskDocument, fc.nat(), (task, partPick) => {
                const parts = partsOf(task)
                fc.pre(parts.length > 0)
                const text = render(task)
                const { editor } = showing(text, parts[partPick % parts.length])
                const whole = editorFixture(`|${text}`).state
                const lines = shownLinesOf(task, parts[partPick % parts.length])
                const shown = (line: number) => lines.has(line)
                for (let line = 1; line <= editor.state.doc.lines; line++) {
                    const expected = chevronLine(whole, line)
                    const want = shown(line) && expected !== null && shown(expected) ? expected : null
                    expect(chevronLine(editor.state, line), `line ${line} of ${JSON.stringify(text)}`).toBe(want)
                }
            }),
            fuzz(300),
        )
    })
})

/** The 1-based lines `part` covers in `render(task)`, counted from the document model, not the editor. */
function shownLinesOf(task: TaskDocument, part: TaskPart): Set<number> {
    const descriptionFrom = 3
    const commentsFrom = descriptionFrom + task.description.length + 1
    const contextFrom = commentsFrom + (task.comments ?? 0)
    const [from, count] =
        part === 'description' ? [descriptionFrom, task.description.length] : part === 'comments' ? [commentsFrom, task.comments ?? 0] : [contextFrom, task.context]
    return new Set(Array.from({ length: count }, (_, i) => from + i))
}

/** Put the caret at the start or the end of a shown line's text. */
function placeCaret(editor: HeadlessEditor, start: { line: number; atEnd: boolean }): void {
    const range = shownRangeIn(editor.state)
    if (!range) return
    const first = editor.state.doc.lineAt(range.from).number
    const last = editor.state.doc.lineAt(range.to).number
    const line = editor.state.doc.line(first + Math.floor(start.line * (last - first + 1)))
    const content = line.from + line.text.indexOf('- ') + 2
    editor.select(start.atEnd ? line.to : content)
}
