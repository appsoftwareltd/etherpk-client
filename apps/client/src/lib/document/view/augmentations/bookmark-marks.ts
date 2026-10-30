/**
 * Where each [[Bookmark]] of the open document is (ADR 0160): the editor's own record, kept exact
 * through every change while the document is open. The view side (`bookmarks.ts`) feeds it the
 * person's bookmarks for this document, draws the marks, and writes back to the bookmark list what
 * this field decides: which bookmarks the person's own edit removed, and which Undo brought back.
 *
 * Framework-free and DOM-free, so the Node tier drives it through the real keymap.
 *
 * - **Placing.** A bookmark that arrives in a sync is placed by its anchor (`resolveAnchor`), or
 *   reported as not found. One the editor could not place yet (the document's text still arriving)
 *   is looked for again by text in what each change writes, and in full when edits settle
 *   ({@link resolveUnplaced}), never in full on every keystroke.
 * - **Following.** A mark is a point on its line: the start of the line's words, or the line's start
 *   when it has none. It follows the words, so Enter at their start takes the bookmark down with them,
 *   a join takes it into the joined line at the point its words begin there, and Undo of the join
 *   takes it back. A line one change writes again (a block move, an indent written as one
 *   replacement) or another change of the same edit writes elsewhere (a line moved in prose or code,
 *   a drag) is found by its text, and a repeated line by its neighbours, so it stays on its own copy.
 *   Two marks that end on one line (a join) become one: the later one goes as if its line had been
 *   deleted.
 * - **Removing.** When the person's own edit takes the line out of the document, the bookmark goes
 *   with it. When another editor's change does (a peer, a reload of a changed file), the bookmark
 *   stays in the list and is reported as not found. It is found again only if a change writes its
 *   text back, never by moving to a similar line elsewhere.
 * - **Undo.** Collaborative editors undo through a Y.UndoManager that never sees CodeMirror
 *   effects, so a removed bookmark is kept here, as a grave holding the line's text at the moment
 *   it went, and comes back when one change writes that text again where it was. That is what Undo
 *   does on both histories.
 */

import { type EditorState, type Extension, type Line, StateEffect, StateField, type Text, type Transaction, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { normaliseLine, resolveAnchor, wordsStart } from '../../bookmarks/anchor'
import { type Bookmark, MAX_BOOKMARKS } from '../../bookmarks/bookmarks'
import { collaborative, EXTERNAL } from '../cm-document'
import { lineRemoved } from '../line-anchor'
import { isOwnEditing } from '../own-editing'
import { placeSelection } from '../view-position'
import { unfoldHiding } from './find-highlight'

/** The person's bookmarks for this document, as the list holds them now. */
export const syncBookmarkMarks = StateEffect.define<readonly Bookmark[]>()

/** Look in full for the bookmarks not placed yet. The view side sends it once edits settle. */
export const resolveUnplaced = StateEffect.define<null>()

interface Mark {
    id: string
    /**
     * A point on the bookmarked line: where its words start, or the line's start when it has none
     * ({@link settle}). After a join it is where the line's words begin inside the joined line.
     */
    pos: number
}

interface Grave {
    /** The bookmark as it was removed, its `text` the line's words at that moment. */
    bookmark: Bookmark
    /** Where the line was, mapped through every change since. */
    pos: number
}

/**
 * What the field decided for the bookmark list, numbered so the view side acts on each entry once
 * however many transactions one view update carries.
 */
export interface OutboxEntry {
    seq: number
    /** The change that made it, counted by {@link BookmarkMarkState.tx}. */
    tx: number
    kind: 'removed' | 'restored'
    bookmark: Bookmark
}

export interface BookmarkMarkState {
    /** The bookmarks of this document from the last sync. */
    bookmarks: readonly Bookmark[]
    marks: readonly Mark[]
    /** Ids of bookmarks whose line is not in the document. */
    notFound: readonly string[]
    /** Of those, the ones another editor's change took away while the document was open. */
    lost: readonly string[]
    graves: readonly Grave[]
    outbox: readonly OutboxEntry[]
    /** The number the next outbox entry gets. */
    seq: number
    /** How many changes this field has followed. Outbox entries are kept by age in changes. */
    tx: number
}

/**
 * How many removed bookmarks are kept for Undo, newest last. Not limited by age: Undo can reach a
 * deletion however much was typed after it, and a grave only comes back when a change writes its
 * line's words where the line was. As many as the list can hold, so one deletion of every bookmarked
 * line of a document restores them all.
 */
const MAX_GRAVES = MAX_BOOKMARKS
/** How many changes an outbox entry is kept for: far more than one view update carries. */
const OUTBOX_CHANGES = 32

const sameLine = (before: string, after: string) => normaliseLine(before) === normaliseLine(after)

const empty: BookmarkMarkState = { bookmarks: [], marks: [], notFound: [], lost: [], graves: [], outbox: [], seq: 0, tx: 0 }

/**
 * Whether the person made this change in this editor, rather than another editor or a reload. A
 * collaborative editor hears a peer's change, and its own Undo, as a transaction with no user event,
 * so there the person's own is what `isOwnEditing` says it is.
 */
function ownEdit(tr: Transaction): boolean {
    if (tr.annotation(EXTERNAL) === true) return false
    return !tr.startState.facet(collaborative) || isOwnEditing(tr)
}

export const bookmarkMarkState = StateField.define<BookmarkMarkState>({
    create: () => empty,
    update(value, tr) {
        let next = value
        if (tr.docChanged) next = followChanges(next, tr)
        for (const effect of tr.effects) {
            if (effect.is(syncBookmarkMarks)) next = sync(next, effect.value, tr.state)
            else if (effect.is(resolveUnplaced)) next = placeUnplaced(next, tr.state)
        }
        return next
    },
})

function followChanges(value: BookmarkMarkState, tr: Transaction): BookmarkMarkState {
    const byId = new Map(value.bookmarks.map((b) => [b.id, b]))
    const own = ownEdit(tr)
    const marks: Mark[] = []
    const lost = new Set(value.lost)
    const tx = value.tx + 1
    const outbox = value.outbox.filter((e) => e.tx > tx - OUTBOX_CHANGES)
    let seq = value.seq
    let graves = value.graves.map((g) => ({ ...g, pos: tr.changes.mapPos(g.pos, -1) }))
    const missing = new Set(value.notFound)

    /** The bookmark's line left the document by this change: remove it, or report it lost. */
    const gone = (id: string, wasAt: number) => {
        const bookmark = byId.get(id)
        if (own && bookmark) {
            const line = tr.startState.doc.lineAt(wasAt)
            const words = normaliseLine(line.text)
            const asRemoved = { ...bookmark, text: words || bookmark.text }
            outbox.push({ seq: seq++, tx, kind: 'removed', bookmark: asRemoved })
            graves.push({ bookmark: asRemoved, pos: tr.changes.mapPos(line.from, -1) })
        } else {
            lost.add(id)
            missing.add(id)
        }
    }

    /** Line starts that hold a mark: one line, one bookmark. */
    const taken = new Set<number>()
    // Top to bottom, so when a join puts two bookmarks on one line the upper line's keeps it.
    for (const mark of [...value.marks].sort((a, b) => a.pos - b.pos)) {
        const pos = followMark(mark.pos, tr)
        const line = pos === null ? null : tr.newDoc.lineAt(pos).from
        // Gone with its line, or now on a line that already has one (a join).
        if (pos === null || line === null || taken.has(line)) {
            gone(mark.id, mark.pos)
            continue
        }
        taken.add(line)
        marks.push({ id: mark.id, pos })
    }

    // A grave whose line's text this change wrote back where it was: Undo.
    graves = graves.filter((grave) => {
        const line = lineWrittenWith(tr, (words) => words === grave.bookmark.text, grave.pos)
        if (line === null || taken.has(line)) return true
        taken.add(line)
        marks.push({ id: grave.bookmark.id, pos: settle(tr.newDoc, line) })
        outbox.push({ seq: seq++, tx, kind: 'restored', bookmark: grave.bookmark })
        return false
    })

    // A bookmark not found may be found in what this change wrote: its text coming back, or the
    // document's text arriving after the editor opened. Only the written lines are read here, so a
    // keystroke never searches the whole document, and only exact text counts. A line this change
    // just took from a bookmark is not looked for again in the same change.
    //
    // A bookmark never placed in this editor, when the change is not the person's own (the text
    // arriving, a reload), is resolved in full by its anchor, so a repeated line goes to its own copy.
    const notFound: string[] = []
    let lines: string[] | null = null
    for (const id of missing) {
        const bookmark = byId.get(id)
        if (!bookmark) continue
        let line: number | null = null
        if (!own && value.notFound.includes(id) && !lost.has(id)) {
            lines ??= tr.newDoc.toJSON()
            const found = resolveAnchor(lines, bookmark)
            line = found === null ? null : tr.newDoc.line(found + 1).from
        } else if (value.notFound.includes(id)) {
            line = lineWrittenWith(tr, (words) => words === bookmark.text)
        }
        if (line === null || taken.has(line)) {
            notFound.push(id)
            continue
        }
        taken.add(line)
        marks.push({ id, pos: settle(tr.newDoc, line) })
        lost.delete(id)
    }

    return {
        ...value,
        marks,
        notFound,
        lost: [...lost].filter((id) => notFound.includes(id)),
        graves: graves.slice(-MAX_GRAVES),
        outbox,
        seq,
        tx,
    }
}

/**
 * Where the mark at `pos` (a point on its line, in the document before `tr`) is after `tr`, or null
 * when `tr` took its line out of the document and wrote it nowhere.
 *
 * A change that replaces the mark's point, or takes its line out, may write the line again: one
 * replacement for a block move or an indent, or another change of the same edit for a line moved in
 * prose or code, or dragged. The line is looked for there by its words ({@link writtenCopy}). Not
 * found, a line taken out is gone, and a point whose words were typed over keeps to its line.
 * Otherwise the point is mapped: leaning forward when the line has words, so Enter at their start
 * takes the mark down with them, and back when it has none, so Enter at an empty bullet's end leaves
 * it where it is.
 */
function followMark(pos: number, tr: Transaction): number | null {
    const line = tr.startState.doc.lineAt(pos)
    const words = normaliseLine(line.text)
    const removed = lineRemoved(line.from, tr, sameLine, wordsStart)
    let replaced = false
    tr.changes.iterChangedRanges((fromA, toA) => {
        if (fromA <= pos && pos < toA) replaced = true
    })
    if (removed || replaced) {
        const copy = writtenCopy(tr, line, words, pos)
        if (copy !== null) return settle(tr.newDoc, copy)
        if (removed) return null
    }
    return settle(tr.newDoc, tr.changes.mapPos(pos, words === '' ? -1 : 1))
}

/**
 * The start of a line `tr` wrote whose words are `words`, or null. Only text a change put in counts,
 * so a deletion is never taken to have written the line after it. With more than one such line (a
 * repeated line, a template's child), the one whose nearest lines with words, above and below, are
 * the lines that were beside it wins, and then the one nearest to where mapping puts `pos`.
 */
function writtenCopy(tr: Transaction, line: Line, words: string, pos: number): number | null {
    const doc = tr.newDoc
    const above = neighbourWords(tr.startState.doc, line.number, -1)
    const below = neighbourWords(tr.startState.doc, line.number, 1)
    const mapped = tr.changes.mapPos(pos, 1)
    let found: number | null = null
    let foundScore = -1
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        if (fromB === toB) return
        for (let n = doc.lineAt(fromB).number, last = doc.lineAt(toB).number; n <= last; n++) {
            const candidate = doc.line(n)
            if (normaliseLine(candidate.text) !== words) continue
            // Its words put in by the change; a line with none, any part of it.
            const start = words === '' ? candidate.to : candidate.from + wordsStart(candidate.text)
            if (start < fromB || candidate.from > toB || (words !== '' && candidate.to > toB)) continue
            const score =
                Number(above !== undefined && neighbourWords(doc, n, -1) === above) + Number(below !== undefined && neighbourWords(doc, n, 1) === below)
            const nearer = found === null || Math.abs(candidate.from - mapped) < Math.abs(found - mapped)
            if (score > foundScore || (score === foundScore && nearer)) {
                found = candidate.from
                foundScore = score
            }
        }
    })
    return found
}

/** The words of the nearest line with words beside 1-based `number`, in direction `step`, or undefined. */
function neighbourWords(doc: Text, number: number, step: -1 | 1): string | undefined {
    for (let n = number + step; n >= 1 && n <= doc.lines; n += step) {
        const words = normaliseLine(doc.line(n).text)
        if (words !== '') return words
    }
    return undefined
}

/**
 * The mark's point on the line holding `pos`: at the start of the line's words or after it (a point
 * inside the words stays where it is), or the line's start when the line has none.
 */
function settle(doc: Text, pos: number): number {
    const line = doc.lineAt(pos)
    if (normaliseLine(line.text) === '') return line.from
    return Math.max(pos, line.from + wordsStart(line.text))
}

/**
 * The start of a line `tr` wrote whose words match, or null. "Wrote" means one change covers the
 * line's words, or puts in the line break the line starts after. Undo of a deleted line is often
 * written as the smallest replacement, which leaves a bullet that was never deleted in place; Undo
 * of a join puts back only the line break. With `near`, only a change reaching the line at that
 * position counts.
 */
function lineWrittenWith(tr: Transaction, matches: (words: string) => boolean, near?: number): number | null {
    const doc = tr.newDoc
    let found: number | null = null
    tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
        if (found !== null || toB === fromB) return
        let first = fromB
        if (near !== undefined) {
            // The line where it was, or the one after it: Undo of a line cleared and then deleted puts
            // back the line break first, and the words on the line after it next.
            const nearLine = doc.lineAt(Math.min(near, doc.length))
            const reach = nearLine.number < doc.lines ? doc.line(nearLine.number + 1).to : nearLine.to
            if (near > toB || reach < fromB) return
            first = Math.min(nearLine.from, fromB)
        }
        for (let n = doc.lineAt(first).number, last = doc.lineAt(toB).number; n <= last; n++) {
            const line = doc.line(n)
            const wordsWritten = fromB <= line.from + wordsStart(line.text) && line.to <= toB
            const breakWritten = fromB < line.from && line.from <= toB
            if ((wordsWritten || breakWritten) && line.length > 0 && matches(normaliseLine(line.text))) {
                found = line.from
                return
            }
        }
    })
    return found
}

function sync(value: BookmarkMarkState, bookmarks: readonly Bookmark[], state: EditorState): BookmarkMarkState {
    const ids = new Set(bookmarks.map((b) => b.id))
    const marks = value.marks.filter((m) => ids.has(m.id))
    const lost = value.lost.filter((id) => ids.has(id))
    const placed = new Set([...marks.map((m) => m.id), ...lost])
    const taken = new Set(marks.map((m) => state.doc.lineAt(m.pos).from))
    const notFound = [...lost]
    let lines: string[] | null = null
    for (const bookmark of bookmarks) {
        if (placed.has(bookmark.id)) continue
        lines ??= state.doc.toJSON()
        const line = resolveAnchor(lines, bookmark)
        const start = line === null ? null : state.doc.line(line + 1).from
        if (start === null || taken.has(start)) notFound.push(bookmark.id)
        else {
            marks.push({ id: bookmark.id, pos: settle(state.doc, start) })
            taken.add(start)
        }
    }
    return {
        ...value,
        bookmarks,
        marks,
        notFound,
        lost,
        // A grave whose bookmark is back in the list (restored elsewhere) has nothing left to restore.
        graves: value.graves.filter((g) => !ids.has(g.bookmark.id)),
    }
}

/** Look in full for the bookmarks never placed in this editor (never those another editor took). */
function placeUnplaced(value: BookmarkMarkState, state: EditorState): BookmarkMarkState {
    const unplaced = value.notFound.filter((id) => !value.lost.includes(id))
    if (unplaced.length === 0) return value
    const lines = state.doc.toJSON()
    const marks = [...value.marks]
    const taken = new Set(marks.map((m) => state.doc.lineAt(m.pos).from))
    const notFound = [...value.lost]
    for (const id of unplaced) {
        const bookmark = value.bookmarks.find((b) => b.id === id)
        const line = bookmark ? resolveAnchor(lines, bookmark) : null
        const start = line === null ? null : state.doc.line(line + 1).from
        if (start === null || taken.has(start)) notFound.push(id)
        else {
            marks.push({ id, pos: settle(state.doc, start) })
            taken.add(start)
        }
    }
    // Nothing new placed: the same state, so nothing downstream takes it for a change.
    if (marks.length === value.marks.length) return value
    return { ...value, marks, notFound }
}

export function bookmarkMarks(): Extension {
    return bookmarkMarkState
}

/** Whether the field has bookmarks it could not place yet, which a full look may still find. */
export function hasUnplaced(state: EditorState): boolean {
    const value = state.field(bookmarkMarkState, false)
    return value !== undefined && value.notFound.some((id) => !value.lost.includes(id))
}

/** The marked lines, 1-based and in document order, each with its bookmark's id. */
export function bookmarkedLines(state: EditorState): { id: string; line: number }[] {
    const value = state.field(bookmarkMarkState, false)
    if (!value) return []
    return value.marks
        .map((m) => ({ id: m.id, line: state.doc.lineAt(Math.min(m.pos, state.doc.length)).number }))
        .sort((a, b) => a.line - b.line)
}

/** The id of the bookmark on 1-based `line`, or null. */
export function bookmarkOnLine(state: EditorState, line: number): string | null {
    return bookmarkedLines(state).find((m) => m.line === line)?.id ?? null
}

/**
 * Show a bookmark's line: every fold hiding it opened, the caret at its start, the line centred. A
 * caret the app places, kept out of the undo history (`placeSelection`), so tidy on leave writes
 * nothing to the line the caret left. Null when the bookmark has no mark in this editor.
 */
export function revealBookmark(state: EditorState, id: string): TransactionSpec | null {
    const mark = bookmarkedLines(state).find((m) => m.id === id)
    if (!mark) return null
    const line = state.doc.line(mark.line)
    return {
        ...placeSelection(line.from),
        effects: [...unfoldHiding(state, line.from, line.to), EditorView.scrollIntoView(line.from, { y: 'center' })],
    }
}
