/**
 * [[Bookmark]]s in the editor (ADR 0159, ADR 0160): the view side of `bookmark-marks.ts`.
 *
 * - Feeds the field this document's bookmarks from the person's list, and writes back what the field
 *   decided (a line the person deleted, a line Undo brought back) and, once edits settle, where each
 *   bookmark now is. Every write runs after the editor's update, never inside it.
 * - Writes nothing of protected text: no position is written back, and no bookmark restored, while
 *   the document is a [[Protected Document]]. The workspace removes a protected page's bookmarks.
 * - Draws a bookmark beside each marked line in the editor's left padding (`CONTENT_PAD_X`), so no
 *   column is added and no text moves. With a mouse, hovering the padding shows a faint one and a
 *   click toggles it (EtherPK, decided 2026-10-29: the padding is where the mark is drawn, as an IDE
 *   toggles a breakpoint in its gutter). On a touch screen the padding is too narrow a target, so it
 *   only displays.
 * - Opens the line Context Menu on a right-click with nothing selected under the pointer, and on
 *   Shift+F10 or the Menu key at the caret, after a link's and a misspelt word's own menus have had
 *   the chance (ADR 0161). Inside a selection, with Shift held on a right-click, and on a widget
 *   drawn in the text, the browser's own menu opens, with its Cut, Copy and Paste.
 * - Shows a bookmark's line when the Sidebar asks (`requestBookmarkReveal`), through the editor's
 *   held reveal when it has one, so activating the tab or the text arriving does not put an older
 *   line back. The request is dropped once the person works in the editor.
 */

import { type EditorState, type Extension, Prec, StateEffect, StateField, Transaction } from '@codemirror/state'
import {
    Decoration,
    type DecorationSet,
    EditorView,
    keymap,
    layer,
    RectangleMarker,
    ViewPlugin,
    type ViewUpdate,
} from '@codemirror/view'

import { showNotice } from '$lib/activity/notices'

import { captureAnchor, normaliseLine, type LineAnchor } from '../../bookmarks/anchor'
import {
    addBookmark,
    bookmarksIn,
    removeBookmarks,
    restoreBookmarks,
    sameConcept,
    subscribeBookmarks,
    updateBookmarkAnchors,
} from '../../bookmarks/bookmarks'
import { reason, removeBookmarksWithUndo } from '../../bookmarks/remove-with-undo'
import {
    BOOKMARK_STATUS_NOTICE_ID,
    dropBookmarkReveal,
    pendingBookmarkReveal,
    reportBookmarkLines,
    subscribeBookmarkReveal,
    takeBookmarkReveal,
} from '../../bookmarks/status'
import { isApplePlatform } from '../../../surface'
import { editorDocument } from '../editor-document'
import { placeSelection } from '../view-position'
import {
    bookmarkMarks,
    bookmarkMarkState,
    bookmarkOnLine,
    bookmarkedLines,
    hasUnplaced,
    resolveUnplaced,
    revealBookmark,
    syncBookmarkMarks,
} from './bookmark-marks'
import { unfoldHiding } from './find-highlight'
import { isProtectedDocumentFacet } from './protected-document'

/** How long edits must pause before bookmark positions are written back to the list. */
export const WRITE_BACK_DELAY_MS = 2000
/** How long a shown line stays highlighted. */
const FLASH_MS = 1200

export interface BookmarkOptions {
    /** Open the line Context Menu for 1-based `line` at viewport `x`/`y`. */
    lineMenu?: (line: number, x: number, y: number) => void
    /** Whether the editor shows a [[Draft]], which has no document to bookmark yet. */
    draft?: boolean
    /**
     * Show 1-based `line`, or the document's top, through the editor's held reveal, with the focus.
     * Without one the bookmark code places the caret itself.
     */
    reveal?: (to: { line: number } | 'top') => void
}

/** Every editor that carries this feature, so a Command acting on a menu target can find its editor. */
const liveViews = new Set<EditorView>()

/** The editor showing `concept` (in `panelId` when given), or null. */
export function bookmarkEditorFor(concept: string, panelId?: string): EditorView | null {
    for (const view of liveViews) {
        const doc = view.state.facet(editorDocument)
        if (!doc || !sameConcept(doc.concept, concept)) continue
        if (panelId === undefined || doc.panelId === panelId) return view
    }
    return null
}

const optionsField = StateField.define<BookmarkOptions>({ create: () => ({}), update: (v) => v })

const isProtected = (state: EditorState) => state.facet(isProtectedDocumentFacet)()

// ---- toggling ----

/**
 * Why 1-based `line` cannot be bookmarked, as the notice says it, or null when it can. A [[Draft]]
 * has no document yet, protected text must never reach the list, and a line with no words (blank,
 * or an empty bullet, task or heading) has nothing to find it by.
 */
export function bookmarkRefusal(state: EditorState, line: number): string | null {
    if (state.field(optionsField, false)?.draft) return 'This page is not written yet. Type in it first, then bookmark the line.'
    if (isProtected(state)) return "Protected text can't be bookmarked."
    if (line < 1 || line > state.doc.lines || normaliseLine(state.doc.line(line).text) === '') {
        return "A line with no words can't be bookmarked. Type something on it first."
    }
    return null
}

/**
 * Bookmark 1-based `line`, or remove its bookmark with Undo. A line that cannot be bookmarked, and
 * a write the backend refuses, each say why in a notice rather than doing nothing.
 */
export async function toggleBookmarkAtLine(view: EditorView, line: number): Promise<void> {
    const existing = bookmarkOnLine(view.state, line)
    try {
        if (existing !== null) {
            await removeBookmarksWithUndo([existing], () => 'Bookmark removed')
            return
        }
        const concept = view.state.facet(editorDocument)?.concept
        if (!concept) return
        const refused = bookmarkRefusal(view.state, line)
        if (refused) {
            showNotice({ id: BOOKMARK_STATUS_NOTICE_ID, tone: 'info', text: refused })
            return
        }
        const anchor = captureAnchor(view.state.doc.toJSON(), line - 1)
        if (!anchor) return
        await addBookmark(concept, anchor)
        // The mark shows beside the line. A screen reader hears it from the editor's own live region.
        if (liveViews.has(view)) view.dispatch({ effects: EditorView.announce.of(`Line ${line} bookmarked`) })
    } catch (err) {
        showNotice({
            id: BOOKMARK_STATUS_NOTICE_ID,
            tone: 'error',
            text: `The bookmark was not saved. ${reason(err)}`.trim(),
        })
    }
}

/** Toggle the bookmark on the caret's line: Ctrl+Alt+K and the Command Menu row. */
export function toggleBookmarkAtCaret(view: EditorView): Promise<void> {
    return toggleBookmarkAtLine(view, view.state.doc.lineAt(view.state.selection.main.head).number)
}

/** A list write after an editor change: refused, it says so once rather than failing quietly. */
function writeQuietly(write: Promise<unknown>, what: string): void {
    write.catch((err: unknown) =>
        showNotice({ id: BOOKMARK_STATUS_NOTICE_ID, tone: 'error', text: `${what} ${reason(err)}`.trim() }),
    )
}

// ---- showing a bookmark's line ----

const flashLine = StateEffect.define<number | null>()

const flashField = StateField.define<DecorationSet>({
    create: () => Decoration.none,
    update(value, tr) {
        let next = value.map(tr.changes)
        for (const effect of tr.effects) {
            if (!effect.is(flashLine)) continue
            next =
                effect.value === null
                    ? Decoration.none
                    : Decoration.set([Decoration.line({ class: 'gk-bookmark-flash' }).range(effect.value)])
        }
        return next
    },
    provide: (field) => EditorView.decorations.from(field),
})

/** The part of an editor the bookmark code drives, so a test can stand in for the DOM view. */
export interface BookmarkHost {
    readonly state: EditorState
    dispatch(...specs: Parameters<EditorView['dispatch']>): void
    focus(): void
}

/** Each editor's timer for its highlight, so a reveal in one editor never leaves another's lit. */
const flashTimers = new WeakMap<BookmarkHost, ReturnType<typeof setTimeout>>()

/**
 * Show the line (`revealBookmark`: every fold hiding it opened), focus the editor and highlight the
 * line briefly. Through the editor's held reveal when it has one (`BookmarkOptions.reveal`).
 */
function revealMarkedLine(view: BookmarkHost, id: string): boolean {
    const spec = revealBookmark(view.state, id)
    const mark = bookmarkedLines(view.state).find((m) => m.id === id)
    if (!spec || !mark) return false
    const reveal = view.state.field(optionsField, false)?.reveal
    const line = view.state.doc.line(mark.line)
    const flash = flashLine.of(line.from)
    if (reveal) {
        // The folds hiding it opened here, the caret and the scroll left to the held reveal.
        view.dispatch({ effects: [...unfoldHiding(view.state, line.from, line.to), flash] })
        reveal({ line: mark.line })
    } else {
        view.dispatch(spec, { effects: flash })
        view.focus()
    }
    // One flash at a time in an editor: a later reveal's highlight is not cleared by an earlier one's timer.
    clearTimeout(flashTimers.get(view))
    flashTimers.set(
        view,
        setTimeout(() => {
            if (liveViews.has(view as EditorView)) view.dispatch({ effects: flashLine.of(null) })
        }, FLASH_MS),
    )
    return true
}

/** Show the top of the document, for a bookmark whose line is gone. */
function revealTop(view: BookmarkHost): void {
    const reveal = view.state.field(optionsField, false)?.reveal
    if (reveal) reveal('top')
    else view.dispatch({ ...placeSelection(0), effects: EditorView.scrollIntoView(0, { y: 'start' }) })
}

// ---- keeping the field and the list in step ----

/**
 * The editor's side of the bookmark list. Exported for its tests, which drive it through a
 * {@link BookmarkHost} with fake timers.
 */
export class BookmarkSync {
    private readonly stopList: () => void
    private readonly stopReveal: () => void
    private writeBack: ReturnType<typeof setTimeout> | undefined
    private lastSynced = ''
    /** The last outbox entry acted on. */
    private seen: number
    /** A write-back the backend refused: none is tried again until the document changes. */
    private writeBackRefused = false
    /**
     * The bookmarks that were unplaced when this editor last looked for them in full. A list change
     * that leaves the same ones unplaced is no reason to look again, so a bookmark whose line is gone
     * never sets two editors of one document writing to each other.
     */
    private lookedFor = ''

    constructor(private readonly view: BookmarkHost) {
        liveViews.add(view as EditorView)
        this.seen = view.state.field(bookmarkMarkState).seq
        this.stopList = subscribeBookmarks(() => this.sync())
        this.stopReveal = subscribeBookmarkReveal(() => this.answerReveal())
    }

    private concept(): string | undefined {
        return this.view.state.facet(editorDocument)?.concept
    }

    private live(): boolean {
        return liveViews.has(this.view as EditorView)
    }

    /**
     * Hand the field this document's bookmarks when they changed (a label included, so a bookmark
     * Undo restores keeps it). Out of the update cycle.
     */
    private sync(): void {
        const concept = this.concept()
        if (!concept) return
        const bookmarks = bookmarksIn(concept)
        const key = JSON.stringify(bookmarks.map((b) => [b.id, b.concept, b.label, b.line, b.text, b.before, b.after]))
        if (key === this.lastSynced) return
        this.lastSynced = key
        queueMicrotask(() => {
            if (!this.live()) return
            const before = this.view.state.field(bookmarkMarkState)
            this.view.dispatch({ effects: syncBookmarkMarks.of(bookmarks) })
            this.placed()
            // Settle at once only when this placing found a line to write back, or left unplaced
            // bookmarks this editor has not looked for in full yet. A list change that placed nothing
            // new (a rollback, a label, another editor's write-back) schedules nothing, so neither a
            // refused write nor two editors of one document set each other writing in a loop.
            if (newlyPlaced(before, this.view.state.field(bookmarkMarkState)) || this.unplacedKey() !== this.lookedFor) {
                // An empty document may be waiting for its text: looked for in full only once edits
                // settle, so a bookmark is not called missing while the text is on its way.
                this.scheduleWriteBack(this.view.state.doc.length === 0 ? WRITE_BACK_DELAY_MS : 0)
            }
        })
    }

    /** The bookmarks this editor has not placed and may still find, as a comparable key. */
    private unplacedKey(): string {
        const state = this.view.state.field(bookmarkMarkState)
        return state.notFound.filter((id) => !state.lost.includes(id)).sort().join(' ')
    }

    /**
     * A request to show a bookmark, answered at once when this editor shows its document and holds
     * its text: the line found in full now, or the top of the document with the reason. An editor
     * whose document is still empty may be waiting for its text, so it leaves the request to the
     * placing that follows.
     */
    private answerReveal(): void {
        const pending = pendingBookmarkReveal()
        const concept = this.concept()
        if (!pending || !concept || !sameConcept(pending.concept, concept)) return
        if (this.view.state.doc.length === 0 && !hasMark(this.view.state, pending.id)) return
        if (!hasMark(this.view.state, pending.id) && hasUnplaced(this.view.state)) {
            this.view.dispatch({ effects: resolveUnplaced.of(null) })
            this.lookedFor = this.unplacedKey()
        }
        this.placed(true)
    }

    /**
     * After the field placed or lost lines: report which lines are missing, and answer a pending
     * request to show one of this document's bookmarks. `lookedInFull` says every way of finding a
     * missing line has been tried, so a request for one can be answered with "not found".
     */
    private placed(lookedInFull = false): void {
        const state = this.view.state.field(bookmarkMarkState)
        // "Line not found" only for a line looked for in full, or taken by another editor: a bookmark
        // not placed yet on opening is not missing, only not looked for, and must not flash the label.
        reportBookmarkLines(
            state.marks.map((m) => m.id),
            lookedInFull ? state.notFound : state.lost,
        )
        const pending = pendingBookmarkReveal()
        const concept = this.concept()
        if (!pending || !concept || !sameConcept(pending.concept, concept)) return
        if (hasMark(this.view.state, pending.id)) {
            if (takeBookmarkReveal(pending.id)) revealMarkedLine(this.view, pending.id)
        } else if (state.notFound.includes(pending.id) && (lookedInFull || state.lost.includes(pending.id))) {
            // Looked for in full and not found: show the document from its top, and say why.
            if (!takeBookmarkReveal(pending.id)) return
            revealTop(this.view)
            showNotice({
                id: BOOKMARK_STATUS_NOTICE_ID,
                tone: 'info',
                text: `The bookmarked line is no longer in "${concept}". Its bookmark stays in the list until you remove it.`,
            })
        }
    }

    update(update: ViewUpdate): void {
        const state = update.state.field(bookmarkMarkState)
        // Every entry since the last update, however many transactions it carried. Written after the
        // update, since writing the list notifies listeners that may dispatch to this editor.
        const entries = state.outbox.filter((e) => e.seq >= this.seen)
        this.seen = state.seq
        if (entries.length > 0) {
            const removed = entries.filter((e) => e.kind === 'removed').map((e) => e.bookmark.id)
            const restored = entries.filter((e) => e.kind === 'restored').map((e) => e.bookmark)
            const protectedNow = isProtected(update.state)
            queueMicrotask(() => {
                if (removed.length > 0) writeQuietly(removeBookmarks(removed), 'The bookmark list was not updated.')
                if (restored.length > 0 && !protectedNow) writeQuietly(restoreBookmarks(restored), 'The bookmark was not put back.')
            })
        }
        // The person working in this editor (a key, a click, a caret move) takes over from a request
        // to show a line here: it must not move the caret under them later.
        if (update.transactions.some((tr) => tr.annotation(Transaction.userEvent) !== undefined)) {
            const concept = this.concept()
            if (concept) dropBookmarkReveal((other) => sameConcept(other, concept))
        }
        if (update.docChanged) {
            this.writeBackRefused = false
            const before = update.startState.field(bookmarkMarkState)
            // Lines found or lost by this change (the text arriving, another editor's edit).
            if (before.notFound.join() !== state.notFound.join()) {
                queueMicrotask(() => {
                    if (this.live()) this.placed()
                })
            }
            this.scheduleWriteBack(WRITE_BACK_DELAY_MS)
        }
    }

    private scheduleWriteBack(delay: number): void {
        if (this.writeBackRefused) return
        clearTimeout(this.writeBack)
        this.writeBack = setTimeout(() => this.settle(), delay)
    }

    /** Once edits settle: look in full for unplaced bookmarks, then store where each one is. */
    private settle(): void {
        this.writeBack = undefined
        if (!this.live()) return
        if (hasUnplaced(this.view.state)) {
            this.view.dispatch({ effects: resolveUnplaced.of(null) })
            // Found or not, the full look is done: report it, and answer a waiting request.
            this.placed(true)
        }
        this.lookedFor = this.unplacedKey()
        this.writeAnchors()
    }

    /**
     * Store each bookmark's current anchor; the list writes only those that changed (ADR 0160 §4).
     * Never for protected text. A refused write says so once and is not tried again until the
     * document changes: the positions are still in the editor.
     */
    private writeAnchors(): void {
        if (isProtected(this.view.state)) return
        const lines = this.view.state.doc.toJSON()
        const updates: { id: string; anchor: LineAnchor }[] = []
        for (const { id, line } of bookmarkedLines(this.view.state)) {
            const anchor = captureAnchor(lines, line - 1)
            if (anchor) updates.push({ id, anchor })
        }
        if (updates.length === 0) return
        updateBookmarkAnchors(updates).catch((err: unknown) => {
            if (this.writeBackRefused) return
            this.writeBackRefused = true
            showNotice({
                id: BOOKMARK_STATUS_NOTICE_ID,
                tone: 'error',
                text: `Where your bookmarks now are was not saved. ${reason(err)} EtherPK tries again after your next edit.`.trim(),
            })
        })
    }

    destroy(): void {
        if (this.writeBack !== undefined) {
            clearTimeout(this.writeBack)
            this.writeAnchors()
        }
        clearTimeout(flashTimers.get(this.view))
        liveViews.delete(this.view as EditorView)
        this.stopList()
        this.stopReveal()
    }
}

/** Whether `after` has a mark `before` did not: the placing found a line. */
function newlyPlaced(before: { marks: readonly { id: string }[] }, after: { marks: readonly { id: string }[] }): boolean {
    const had = new Set(before.marks.map((m) => m.id))
    return after.marks.some((m) => !had.has(m.id))
}

function hasMark(state: EditorState, id: string): boolean {
    return state.field(bookmarkMarkState, false)?.marks.some((m) => m.id === id) ?? false
}

// ---- the padding: drawing, hovering, clicking ----

const hoverLine = StateEffect.define<number | null>()

/** The 1-based line whose padding the mouse is over, for the faint bookmark. */
const hoverField = StateField.define<number | null>({
    create: () => null,
    update(value, tr) {
        let next = value
        for (const effect of tr.effects) if (effect.is(hoverLine)) next = effect.value
        if (next !== null && tr.docChanged) next = null
        return next
    },
})

/** Size of the drawn bookmark, px. Fits the 20px padding with room either side. */
const ICON_WIDTH = 10
const ICON_HEIGHT = 14

/** The padding's horizontal extent in client coordinates. */
function paddingBand(view: EditorView): { left: number; right: number } {
    const rect = view.contentDOM.getBoundingClientRect()
    const padding = parseFloat(getComputedStyle(view.contentDOM).paddingLeft) || 0
    return { left: rect.left, right: rect.left + padding }
}

/** The 1-based line beside the pointer, when the pointer is in the padding. */
function paddingLineAt(view: EditorView, event: MouseEvent): number | null {
    const band = paddingBand(view)
    if (event.clientX < band.left || event.clientX >= band.right) return null
    const pos = view.posAtCoords({ x: band.right + 1, y: event.clientY })
    return pos === null ? null : view.state.doc.lineAt(pos).number
}

function markers(view: EditorView): RectangleMarker[] {
    const scroller = view.scrollDOM.getBoundingClientRect()
    const origin = {
        left: scroller.left - view.scrollDOM.scrollLeft * view.scaleX,
        top: scroller.top - view.scrollDOM.scrollTop * view.scaleY,
    }
    const band = paddingBand(view)
    const left = (band.left + band.right) / 2 - ICON_WIDTH / 2 - origin.left
    const marked = new Set(bookmarkedLines(view.state).map((m) => m.line))
    const hovered = view.state.field(hoverField, false) ?? null
    const out: RectangleMarker[] = []
    const draw = (line: number, cls: string) => {
        const from = view.state.doc.line(line).from
        if (from < view.viewport.from || from > view.viewport.to) return
        // A line inside a fold, or under a widget that replaces it, has no row of its own: the block
        // there starts elsewhere. Draw nothing rather than mark the fold's or the widget's line.
        if (view.lineBlockAt(from).from !== from) return
        // Centred on the line's first row, as tall as that row's text: a heading's row is taller.
        const row = view.coordsAtPos(from, 1)
        if (!row) return
        const top = (row.top + row.bottom) / 2 - ICON_HEIGHT / 2 - origin.top
        out.push(new RectangleMarker(cls, left, top, ICON_WIDTH, ICON_HEIGHT))
    }
    for (const line of marked) draw(line, 'gk-bookmark')
    if (hovered !== null && !marked.has(hovered) && hovered <= view.state.doc.lines) draw(hovered, 'gk-bookmark gk-bookmark-ghost')
    return out
}

const bookmarkLayer = layer({
    above: true,
    class: 'gk-bookmark-layer',
    markers,
    update: (update) =>
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.startState.field(bookmarkMarkState).marks !== update.state.field(bookmarkMarkState).marks ||
        update.startState.field(hoverField) !== update.state.field(hoverField),
})

/** Whether the editor's last pointer was a finger, from its pointerdown. */
const touchPointer = new WeakMap<EditorView, boolean>()

/** Open the line menu for the caret's line, below the caret: Shift+F10 and the Menu key. */
function lineMenuAtCaret(view: EditorView): boolean {
    const options = view.state.field(optionsField, false)
    if (!options?.lineMenu) return false
    const head = view.state.selection.main.head
    const coords = view.coordsAtPos(head)
    if (!coords) return false
    options.lineMenu(view.state.doc.lineAt(head).number, coords.left, coords.bottom)
    return true
}

const handlers = EditorView.domEventHandlers({
    pointerdown(event, view) {
        touchPointer.set(view, event.pointerType === 'touch')
        return false
    },
    mousemove(event, view) {
        const line = touchPointer.get(view) ? null : paddingLineAt(view, event)
        if (line !== view.state.field(hoverField)) view.dispatch({ effects: hoverLine.of(line) })
        return false
    },
    mouseleave(_event, view) {
        if (view.state.field(hoverField) !== null) view.dispatch({ effects: hoverLine.of(null) })
        return false
    },
    mousedown(event, view) {
        if (event.button !== 0) return false
        // On a Mac, Control with a click is a right-click: the line menu that follows is its answer.
        if (event.ctrlKey && isApplePlatform()) return false
        // A touch screen raises mousedown for a tap; the padding is too narrow a target for a finger.
        if (touchPointer.get(view)) return false
        const line = paddingLineAt(view, event)
        if (line === null) return false
        event.preventDefault()
        void toggleBookmarkAtLine(view, line)
        return true
    },
    contextmenu(event, view) {
        const options = view.state.field(optionsField, false)
        if (!options?.lineMenu || event.shiftKey) return false
        // A touch hold is native text selection on a phone.
        if (touchPointer.get(view)) return false
        // A widget drawn in the text (an image, maths, a card) keeps the browser's menu, with its own
        // rows such as Copy Image. A bullet's dot and a task's checkbox are marks on the line's text.
        const widget = event.target instanceof Element ? event.target.closest('[contenteditable="false"]') : null
        if (widget && widget !== view.contentDOM && view.contentDOM.contains(widget)) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? paddingPos(view, event)
        if (pos === null) return false
        const selection = view.state.selection.main
        if (!selection.empty && selection.from <= pos && pos <= selection.to) return false
        event.preventDefault()
        // As a browser does on a right-click in text: the caret goes where the pointer is, so Paste
        // lands there.
        view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' })
        options.lineMenu(view.state.doc.lineAt(pos).number, event.clientX, event.clientY)
        return true
    },
})

function paddingPos(view: EditorView, event: MouseEvent): number | null {
    const line = paddingLineAt(view, event)
    return line === null ? null : view.state.doc.line(line).from
}

const theme = EditorView.baseTheme({
    '.gk-bookmark-layer': { pointerEvents: 'none' },
    '.gk-bookmark': {
        backgroundColor: 'var(--gk-accent, #0a66c2)',
        // A ribbon with a notch at its foot.
        clipPath: 'polygon(0 0, 100% 0, 100% 100%, 50% 72%, 0 100%)',
    },
    '.gk-bookmark.gk-bookmark-ghost': { backgroundColor: 'var(--gk-border-strong, #9ca3af)' },
    '.gk-bookmark-flash': {
        backgroundColor: 'var(--gk-find-current, rgba(234, 88, 12, 0.25))',
        transition: 'background-color 160ms ease-out',
    },
    '@media (prefers-reduced-motion: reduce)': { '.gk-bookmark-flash': { transition: 'none' } },
})

/** The bookmarks feature. `options` come from the editor that mounts it. */
export function bookmarksAugmentation(options: BookmarkOptions = {}): Extension {
    return [
        bookmarkMarks(),
        optionsField.init(() => options),
        hoverField,
        flashField,
        ViewPlugin.fromClass(BookmarkSync),
        bookmarkLayer,
        handlers,
        // After the link's and the spelling menu's own bindings for the same keys, which claim them
        // on their targets.
        Prec.low(
            keymap.of([
                { key: 'Shift-F10', run: lineMenuAtCaret },
                { key: 'ContextMenu', run: lineMenuAtCaret },
            ]),
        ),
        theme,
    ]
}
