/**
 * A [[Fold]]: the [[Block]]s nested under a bullet hidden, its own line showing (Editor Content
 * Rules → Folds). CodeMirror's `codeFolding` holds the folded ranges, since its field already keeps
 * the caret out of them, opens one the selection lands in, and is what Find opens a match with
 * (find-highlight.ts). This module decides what a fold covers and keeps it covering that:
 *
 * - **A fold covers its bullet's children.** It runs from the end of the bullet's own text (its line
 *   and the soft lines and code block it owns, which stay shown) to the end of its branch. Only a
 *   bullet with a child bullet folds.
 * - **A fold follows its branch.** After every change, the person's own or a peer's, each fold is
 *   found again from its bullet's branch, so a child added at the foot of a folded branch is hidden
 *   with the rest. CodeMirror's mapping alone would leave it showing.
 * - **A fold ends with its bullet**: when the bullet is deleted, merged away, or left with no child.
 * - **A fold moves with its text.** A branch move replaces the lines it carries, which deletes a
 *   fold inside them; a fold whose bullet's branch comes back unchanged in the change's inserted
 *   text is put back there.
 *
 * Everything here reads a state, never a view, so the rule tables run it in Node.
 */

import { codeFolding, foldEffect, foldedRanges, foldService, unfoldEffect } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { type ChangeSet, EditorState, type Extension, MapMode, type StateEffect, type Text, type Transaction, type TransactionSpec } from '@codemirror/state'

import { fencedBlocks } from '../../fenced-code'
import { ownerBulletIndex } from '../../outliner'
import { analysisFor } from '../analysis/editor-analysis'
import { branchEnds } from './outline-guides-core'

/** A fold's range: document offsets, `from` at the end of the bullet's own text, `to` at its branch's end. */
export interface FoldRange {
    from: number
    to: number
}

/** The lines of a document and their branch ends, which every question here starts from. */
interface Outline {
    lines: readonly string[]
    ends: readonly number[]
}

/** A state's outline, from the editor's analysis, which is kept up to date as the text changes. */
function outlineIn(state: EditorState): Outline {
    const { lines, branchEnds: ends } = analysisFor(state)
    return { lines, ends }
}

/**
 * A new document's outline, read from its text: a transaction extender sees the new document before
 * the analysis of it exists.
 */
function outlineOf(doc: Text): Outline {
    const lines = doc.toString().split('\n')
    return { lines, ends: branchEnds(lines, fencedBlocks(lines)) }
}

/**
 * The range a fold of the bullet on 0-based line `i` covers, or null when it has no child bullet.
 * Its own text ends before its first child bullet, less any blank lines in between, which fold away
 * with the children.
 */
function foldRangeIn({ lines, ends }: Outline, doc: Text, i: number): FoldRange | null {
    const end = ends[i]
    if (end === undefined || end <= i) return null
    let firstChild = i + 1
    while (firstChild <= end && ends[firstChild] < 0) firstChild++
    if (firstChild > end) return null
    let ownEnd = firstChild - 1
    while (ownEnd > i && lines[ownEnd].trim() === '') ownEnd--
    return { from: doc.line(ownEnd + 1).to, to: doc.line(end + 1).to }
}

/** The range a fold of the bullet on 1-based line `line` would cover, or null when it cannot fold. */
export function bulletFoldRange(state: EditorState, line: number): FoldRange | null {
    return foldRangeIn(outlineIn(state), state.doc, line - 1)
}

/** Whether the bullet on 1-based line `line` has children to fold. */
export function isFoldableBullet(state: EditorState, line: number): boolean {
    return bulletFoldRange(state, line) !== null
}

/** The fold in `state` exactly covering `range`, if one is there. */
function hasFold(state: EditorState, range: FoldRange): boolean {
    let found = false
    foldedRanges(state).between(range.from, range.from, (from, to) => {
        if (from === range.from && to === range.to) found = true
    })
    return found
}

/** The fold of the bullet on 1-based line `line`, or null when it is not folded. */
export function foldOfBullet(state: EditorState, line: number): FoldRange | null {
    const range = bulletFoldRange(state, line)
    return range && hasFold(state, range) ? range : null
}

/** Whether the bullet on 1-based line `line` is folded. */
export function isFoldedBullet(state: EditorState, line: number): boolean {
    return foldOfBullet(state, line) !== null
}

/** Every fold in `state`, in document order. */
export function allFolds(state: EditorState): FoldRange[] {
    const out: FoldRange[] = []
    foldedRanges(state).between(0, state.doc.length, (from, to) => {
        out.push({ from, to })
    })
    return out
}

/** The 1-based line of the bullet a fold belongs to: the bullet owning the line its range starts on. */
function bulletOfFold(outline: Outline, doc: Text, from: number): number | null {
    const index = doc.lineAt(from).number - 1
    const owner = ownerBulletIndex(outline.lines as string[], index)
    return owner === null ? null : owner + 1
}

/** The 1-based lines of every folded bullet in `state`. */
export function foldedBulletLines(state: EditorState): number[] {
    const folds = allFolds(state)
    if (folds.length === 0) return []
    const outline = outlineIn(state)
    const out: number[] = []
    for (const fold of folds) {
        const line = bulletOfFold(outline, state.doc, fold.from)
        if (line !== null) out.push(line)
    }
    return out
}

/**
 * The transaction that folds or unfolds the bullet on 1-based line `line`, or null when it has no
 * children. A selection inside what the fold hides is moved to the end of the bullet's own text, as
 * CodeMirror's field would otherwise open the fold again at once.
 */
export function toggleBulletFoldSpec(state: EditorState, line: number): TransactionSpec | null {
    const range = bulletFoldRange(state, line)
    if (!range) return null
    if (hasFold(state, range)) return { effects: unfoldEffect.of(range), userEvent: 'fold' }
    const head = state.selection.main.head
    const inside = head > range.from && head <= range.to
    return { effects: foldEffect.of(range), ...(inside ? { selection: { anchor: range.from } } : {}), userEvent: 'fold' }
}

/** The transaction that opens every fold in the branch of the bullet on 1-based line `line`, its own included. */
export function unfoldBranchSpec(state: EditorState, line: number): TransactionSpec | null {
    const outline = outlineIn(state)
    const end = outline.ends[line - 1]
    if (end === undefined || end < line - 1) return null
    const from = state.doc.line(line).from
    const to = state.doc.line(end + 1).to
    const effects: StateEffect<unknown>[] = []
    foldedRanges(state).between(from, to, (a, b) => {
        if (a >= from && b <= to) effects.push(unfoldEffect.of({ from: a, to: b }))
    })
    return effects.length ? { effects, userEvent: 'fold' } : null
}

/** Whether any bullet under the one on 1-based line `line` (not itself) is folded. */
export function hasFoldedDescendant(state: EditorState, line: number): boolean {
    const own = bulletFoldRange(state, line)
    if (!own) return false
    const ownFold = hasFold(state, own)
    let found = false
    foldedRanges(state).between(own.from, own.to, (a, b) => {
        if (a >= own.from && b <= own.to && !(ownFold && a === own.from && b === own.to)) found = true
    })
    return found
}

/**
 * Where a folded branch that a change deleted came back, if it did: the change's inserted text holds
 * the branch (its bullet line to its last line) unchanged, as whole lines. Returns the new offset of
 * the branch's first line. A branch move inserts from the start of a line, so a match at the start
 * of the inserted text counts as one.
 */
function movedBranchStart(startDoc: Text, changes: ChangeSet, branchFrom: number, branchTo: number): number | null {
    const text = startDoc.sliceString(branchFrom, branchTo)
    let found: number | null = null
    changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
        if (found !== null || branchFrom < fromA || branchTo > toA) return
        const insert = inserted.toString()
        for (let at = insert.indexOf(text); at >= 0; at = insert.indexOf(text, at + 1)) {
            const lineStart = at === 0 || insert[at - 1] === '\n'
            const lineEnd = at + text.length === insert.length || insert[at + text.length] === '\n'
            if (lineStart && lineEnd) {
                found = fromB + at
                return
            }
        }
    })
    return found
}

/** The 1-based line in the new document of the folded bullet starting at `bulletFrom`, or null when it is gone. */
function bulletLineAfter(tr: Transaction, bulletFrom: number, foldTo: number): number | null {
    // The moved text first: a replacement that starts at the bullet's line maps its start to the
    // replacement's end, which is not where a branch it carries lands.
    const moved = movedBranchStart(tr.startState.doc, tr.changes, bulletFrom, foldTo)
    if (moved !== null) return tr.newDoc.lineAt(moved).number
    const mapped = tr.changes.mapPos(bulletFrom, 1, MapMode.TrackDel)
    return mapped === null ? null : tr.newDoc.lineAt(mapped).number
}

/** The folds the rules give the new document: each folded bullet's branch where the bullet is now. */
function followedFolds(tr: Transaction, before: readonly FoldRange[]): FoldRange[] {
    const startDoc = tr.startState.doc
    const oldOutline = outlineIn(tr.startState)
    const outline = outlineOf(tr.newDoc)
    const kept = new Map<number, FoldRange>()
    for (const fold of before) {
        const bullet = bulletOfFold(oldOutline, startDoc, fold.from)
        const line = bullet === null ? null : bulletLineAfter(tr, startDoc.line(bullet).from, fold.to)
        const range = line === null ? null : foldRangeIn(outline, tr.newDoc, line - 1)
        if (range && !kept.has(range.from)) kept.set(range.from, range)
    }
    return [...kept.values()]
}

/** Whether the caret is in what `fold` hides: anywhere past the end of the bullet's own text, its end included. */
function holdsCaret(fold: FoldRange, head: number): boolean {
    return head > fold.from && head <= fold.to
}

/**
 * What a transaction does to the folds (the module comment's rules). A document change finds each
 * fold's bullet in the new document, through the change or by its moved text, and sets its fold to
 * that bullet's branch; a bullet that is gone or has no child loses its fold. Then no fold may hold
 * the caret: CodeMirror opens one the caret lands strictly inside, but a caret at a fold's end, where
 * an arrow key or a change can leave it, would type into hidden text, so that fold opens too.
 */
export function foldFollowEffects(tr: Transaction): StateEffect<unknown>[] {
    if (!tr.docChanged && !tr.selection) return []
    const before = allFolds(tr.startState)
    if (before.length === 0) return []
    // The folds CodeMirror's mapping leaves, and the ones the rules give.
    const mappedFolds: FoldRange[] = []
    foldedRanges(tr.startState)
        .map(tr.changes)
        .between(0, tr.newDoc.length, (from, to) => {
            mappedFolds.push({ from, to })
        })
    const head = tr.newSelection.main.head
    const kept = (tr.docChanged ? followedFolds(tr, before) : mappedFolds).filter((fold) => !holdsCaret(fold, head))
    const same = (a: FoldRange, b: FoldRange) => a.from === b.from && a.to === b.to
    const effects: StateEffect<unknown>[] = []
    for (const fold of mappedFolds) if (!kept.some((k) => same(k, fold))) effects.push(unfoldEffect.of(fold))
    for (const fold of kept) if (!mappedFolds.some((m) => same(m, fold))) effects.push(foldEffect.of(fold))
    return effects
}

/**
 * A fold is CodeMirror's replace decoration over a range that ends a line: the screen reader is told
 * what it hides in place of the `…` box, which the folded bullet's disc replaces (bullet-marker.ts).
 */
function placeholderDOM(_view: unknown, _onclick: unknown, prepared: unknown): HTMLElement {
    const span = document.createElement('span')
    span.className = 'gk-fold-hidden'
    const count = typeof prepared === 'number' ? prepared : 0
    span.textContent = count === 1 ? 'folded, 1 block hidden' : `folded, ${count} blocks hidden`
    return span
}

/** How many blocks a fold hides: the bullet lines inside it. */
function hiddenBlocks(state: EditorState, range: { from: number; to: number }): number {
    const outline = outlineIn(state)
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    let count = 0
    for (let i = first; i < last; i++) if (outline.ends[i] >= 0) count++
    return count
}

/** The bullet fold service for CodeMirror's own commands (fold at a line). */
const bulletFoldService = foldService.of((state, lineStart) => bulletFoldRange(state, state.doc.lineAt(lineStart).number))

/** The fold machinery: CodeMirror's fold field configured for bullets, and the follow rules. */
export function outlineFolds(): Extension {
    return [
        codeFolding({ placeholderDOM, preparePlaceholder: hiddenBlocks }),
        bulletFoldService,
        EditorState.transactionExtender.of((tr) => {
            const effects = foldFollowEffects(tr)
            return effects.length ? { effects } : null
        }),        // The words a fold leaves for a screen reader, out of sight: the folded bullet's disc is what
        // a sighted reader sees.
        EditorView.baseTheme({
            '.gk-fold-hidden': {
                position: 'absolute',
                width: '1px',
                height: '1px',
                overflow: 'hidden',
                clipPath: 'inset(50%)',
                whiteSpace: 'nowrap',
            },
        }),
    ]
}
