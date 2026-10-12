/**
 * Augmentation host: **interactive fences** (`interactive-fence-contract.ts`). A complete fence
 * whose info word has a registered widget is drawn as that widget, live, while no selection touches
 * it, and as its text while one does, as a rendered fence is (ADR 0022). The [[Map Block]] is the
 * first (ADR 0118): the map is what the page shows, and its places are lines of text that the map's
 * own controls change, or that a person edits with the caret in them.
 *
 * What the host owns, so a widget never has to know the editor:
 *
 * - **The widget's life.** CodeMirror builds the widget's DOM when its block comes into the
 *   viewport and destroys it when the block leaves or is deleted, or when the caret shows the
 *   fence's text. Between those, a change to the fence's body, the theme, whether it can be
 *   written or whether the editor is on screen (editor-on-screen.ts) reaches the mounted widget
 *   through `updateDOM`, so the widget and whatever it holds (a map, with its WebGL context)
 *   survive the edit. The widget's height is its own declared height, reserved before it mounts,
 *   and a change of it rides a decoration redraw so the height map never drifts (ADR 0022's rule).
 * - **Which fence is which.** Every fence keeps an id across edits (`fenceIdentity`). A widget's
 *   DOM is only ever handed back to the same fence, and a widget's edits find their fence by its
 *   id, so nothing a widget does can land in another one.
 * - **The edits.** A widget asks for one line change at a time (`fence-body.ts`). The host finds
 *   the fence by its id, checks the line still says what the widget read, writes it at the fence's
 *   indentation, and dispatches it as an ordinary editor change, so it is undone with the editor's
 *   own undo and synced and merged like typing.
 * - **The caret.** The fence is a fenced block like any other: the caret on its lines, or a
 *   selection reaching it, shows its text (interactive-fence-state.ts), and beside it the keys are a
 *   code block's. ArrowDown and ArrowUp from the line beside it step into its text, at the opener's
 *   fence column or the closer's end (`arrowIntoCollapsedFence`). A press inside the widget is the
 *   widget's and never moves the caret, so a click on a map pans it or adds a place.
 * - **Where it is drawn.** Over its whole lines, from where the opener's text starts. A fence opened
 *   on a bullet's line (`- ```map`, form 1) is drawn after the marker instead, beside the bullet's
 *   dot, and a press on that line beside the widget shows its text.
 * - **The text.** **Edit as text**, in the widget's menu, puts the caret on the fence's first body
 *   line, which shows it as the ordinary fenced block it is.
 * - **Extension Fences** (ADR 0138) differ only at the caret. Their text shows only when asked for
 *   (requested-kind reveal), the caret passes over them as one block (`extensionFenceAtoms`,
 *   `extensionFenceCaret`), and a person's typing never changes their lines (`extensionFenceEdits`).
 */
import {
    type ChangeSet,
    type ChangeSpec,
    EditorSelection,
    EditorState,
    type Extension,
    Prec,
    type Range,
    RangeSet,
    RangeValue,
    type SelectionRange,
    StateEffect,
    StateField,
    Transaction,
    type TransactionSpec,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView, keymap, runScopeHandlers, ViewPlugin, WidgetType } from '@codemirror/view'

import { type ContributionRegistry, tryGetActiveContributionRegistry } from '$lib/surface'

import { analysisFor } from '../analysis/editor-analysis'
import { editorDocument } from '../editor-document'
import { editorIsOnScreen, setEditorOnScreen } from '../editor-on-screen'
import { bodyWritable } from '../body-writable'
import { clampedCaret } from '../caret-clamp'
import { refusalIn } from '../edit-refused'
import { type FenceBodyEdit, fenceBodyEditApplies, safeFenceLine } from '../../fence-body'
import { BLOCK_WIDGET_SPACING, BULLET_BLOCK_DROP, blockWidgetIndent } from './content-clamp'
import { fenceHosting } from '../fence-hosting'
import {
    fenceRegistrationsChanged,
    INTERACTIVE_FENCE_KIND,
    type InteractiveFence,
    type InteractiveFenceContext,
    type InteractiveFenceInfo,
    type InteractiveFenceView,
    isExtensionFenceInfo,
} from './interactive-fence-contract'
import {
    collapsedExtensionFences,
    collapsedInteractiveFences,
    collapsedOrdinaryFences,
    fenceById,
    fenceIdAt,
    fenceIdentity,
    type InteractiveFenceRange,
    interactiveFences,
} from './interactive-fence-state'
import { arrowIntoCollapsedFence, isDark, pressBesideFormOne, themeTick } from './rendered-common'
import { rangeTouches, requestedRevealField, requestReveal } from './reveal-policy'

/** Dispatched when a widget's height changed, so the block is measured again. */
const fenceResized = StateEffect.define<null>()

/** A widget's height when its extension cannot say: a map's, as on a narrow screen. */
const FALLBACK_HEIGHT = 320

/**
 * The room a widget takes beyond its declared height, in pixels, as last measured for each way it is
 * drawn: a block's padding above and below (`BLOCK_WIDGET_SPACING`), and an inline widget's drop
 * above and padding below. Every widget of a kind carries the same at the editor's font size, so the
 * first one laid out tells the estimate for the rest, which the height map then reserves before a
 * widget scrolls into view.
 */
const measuredExtra = { block: 0, inline: 0 }

/**
 * The widget's declared height, or the fallback when its extension throws: the decorations are
 * built inside the editor's own update, where an error would refuse every transaction.
 */
function declaredHeight(fence: InteractiveFence, info: InteractiveFenceInfo): number {
    try {
        const height = fence.height(info)
        return Number.isFinite(height) && height > 0 ? height : FALLBACK_HEIGHT
    } catch {
        return FALLBACK_HEIGHT
    }
}

/** The editor's undo and redo chords, which a widget's own buttons would otherwise swallow. */
function historyChord(event: KeyboardEvent): boolean {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return false
    const key = event.key.toLowerCase()
    return key === 'z' || key === 'y'
}

/** Whether a key goes to a field the person is typing in, which keeps its own undo. */
function typingField(target: EventTarget | null): boolean {
    return target instanceof HTMLElement && (target.isContentEditable || target.tagName === 'TEXTAREA' || (target.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'file'].includes((target as HTMLInputElement).type)))
}

/**
 * The mounted widget behind each block's DOM, with the id of the fence it was mounted for and how it
 * was drawn, so an update reaches the widget CodeMirror kept and never one mounted for another fence.
 */
const mounted = new WeakMap<HTMLElement, { id: number; fence: InteractiveFence; inline: boolean; view: InteractiveFenceView; host: HTMLElement }>()

/**
 * The line changes for one body edit, written at the fence's indentation, or null when the edit
 * no longer applies (its line is gone, or no longer says what the widget read). Pure over the
 * state, so the Node tier checks it without a view.
 */
export function fenceEditChanges(state: EditorState, fence: InteractiveFenceRange, edit: FenceBodyEdit): ChangeSpec | null {
    if (!fenceBodyEditApplies(fence.body, edit)) return null
    const closer = state.doc.line(fence.end + 1)
    // The closer sits at the fence column, so its indentation is exactly what a body line needs:
    // the bullet's content column inside an outline, nothing in prose.
    const indent = closer.text.slice(0, fence.fenceColumn)
    if (edit.kind === 'insert') {
        const at = edit.line < fence.body.length ? state.doc.line(fence.start + 2 + edit.line).from : closer.from
        return { from: at, insert: `${indent}${safeFenceLine(edit.text)}\n` }
    }
    const line = state.doc.line(fence.start + 2 + edit.line)
    // A replacement takes its line break with it. Two devices replacing the same line then each
    // delete it whole and write a whole line, and a merge keeps both as lines of their own, where
    // replacing only the text put both texts on one line, which read as neither (ADR 0138). The
    // body line always has a break after it, the closer's line being below it.
    if (edit.kind === 'replace') return { from: line.from, to: line.to + 1, insert: `${indent}${safeFenceLine(edit.text)}\n` }
    return { from: line.from, to: line.to + 1 }
}

/**
 * The changes several of a widget's edits make together, each read against the body the ones before
 * it left, as one change set; or null when any of them no longer applies, and then none is made.
 */
export function widgetEditsChanges(state: EditorState, id: number, edits: readonly FenceBodyEdit[]): ChangeSet | null {
    let current = state
    let composed: ChangeSet | null = null
    for (const edit of edits) {
        const fence = fenceById(current, id)
        const spec = fence ? fenceEditChanges(current, fence, edit) : null
        if (!spec) return null
        const changes = current.changes(spec)
        composed = composed ? composed.compose(changes) : changes
        // Unfiltered: a change a filter added here would be in `current` and not in `composed`, and
        // the next edit's changes would no longer line up with it. The filters see the whole edit
        // when it is dispatched.
        current = current.update({ changes, filter: false }).state
    }
    return composed
}

function infoOf(fence: InteractiveFenceRange, state: EditorState): InteractiveFenceInfo {
    return { info: fence.info, body: fence.body, document: state.facet(editorDocument)?.concept ?? null, ordinal: fence.ordinal }
}

function sameInfo(a: InteractiveFenceInfo, b: InteractiveFenceInfo): boolean {
    return (
        a.info === b.info &&
        a.document === b.document &&
        a.ordinal === b.ordinal &&
        a.body.length === b.body.length &&
        a.body.every((line, i) => line === b.body[i])
    )
}

class InteractiveFenceWidget extends WidgetType {
    constructor(
        /** The fence's identity (`fenceIdentity`): which fence this widget draws, across edits. */
        readonly id: number,
        readonly fence: InteractiveFence,
        readonly info: InteractiveFenceInfo,
        readonly writable: boolean,
        readonly dark: boolean,
        /** Whether anyone can see the editor (editor-on-screen.ts). */
        readonly onScreen: boolean,
        readonly height: number,
        /** Drawn after a bullet's marker, for a form-1 fence, rather than over whole lines. */
        readonly inline: boolean,
        /** Where the opener line's text starts (`blockWidgetIndent`), or null inline and at column 0. */
        readonly indent: string | null,
    ) {
        super()
    }

    eq(other: InteractiveFenceWidget): boolean {
        return (
            other.id === this.id &&
            other.fence === this.fence &&
            sameInfo(other.info, this.info) &&
            other.writable === this.writable &&
            other.dark === this.dark &&
            other.onScreen === this.onScreen &&
            other.height === this.height &&
            other.inline === this.inline &&
            other.indent === this.indent
        )
    }

    /** The widget and the room round it, so a widget off screen reserves its whole height. */
    get estimatedHeight(): number {
        return this.height + measuredExtra[this.inline ? 'inline' : 'block']
    }

    toDOM(view: EditorView): HTMLElement {
        // Inline, a span in the bullet's line, as a rendered fence's form-1 widget is (fence-render.ts).
        const root: HTMLElement = document.createElement(this.inline ? 'span' : 'div')
        root.className = this.inline ? 'gk-interactive-fence gk-interactive-fence--inline' : 'gk-interactive-fence'
        root.setAttribute('data-interactive-fence', this.info.info)
        root.contentEditable = 'false'
        const host = root.appendChild(document.createElement('div'))
        host.className = 'gk-interactive-fence-host'
        this.place(root, host)
        // The editor ignores keys inside a widget, so after a widget's own edit Mod+Z would reach
        // nothing; outside a field the person is typing in, the chord is the editor's undo or redo.
        // A widget that keeps its own undo (a drawing) keeps the chord. The key's own target is read
        // through the event's path, since a loaded extension's widget sits in a shadow root, whose
        // fields the event's target hides.
        root.addEventListener('keydown', (event) => {
            if (this.fence.keepsHistory || !historyChord(event) || typingField(event.composedPath()[0] ?? event.target)) return
            if (runScopeHandlers(view, event, 'editor')) event.preventDefault()
        })
        mounted.set(root, { id: this.id, fence: this.fence, inline: this.inline, view: this.fence.mount(host, this.context(view)), host })
        const kind = this.inline ? 'inline' : 'block'
        requestAnimationFrame(() => {
            if (!root.isConnected) return
            // An inline widget's drop is a margin, which its line measures but its own box leaves out.
            const drop = this.inline ? parseFloat(getComputedStyle(root).marginTop) || 0 : 0
            const extra = root.getBoundingClientRect().height + drop - host.getBoundingClientRect().height
            if (extra > 0) measuredExtra[kind] = extra
        })
        return root
    }

    /**
     * Take over DOM CodeMirror kept, only when it was mounted for this same fence by this same
     * widget, drawn the same way. When a fence is redrawn, CodeMirror offers it the DOM of any widget
     * of this class it holds, the deleted fence above it included, and that DOM carries another
     * fence's widget and everything it holds. And an extension started again registers a new widget
     * for the same word, whose DOM must be its own, not one holding what the stopped run gave it.
     */
    updateDOM(dom: HTMLElement, view: EditorView): boolean {
        const entry = mounted.get(dom)
        if (!entry || entry.id !== this.id || entry.fence !== this.fence || entry.inline !== this.inline) return false
        this.place(dom, entry.host)
        entry.view.update(this.context(view))
        return true
    }

    destroy(dom: HTMLElement): void {
        const entry = mounted.get(dom)
        mounted.delete(dom)
        entry?.view.destroy()
    }

    /** Events inside the widget are the widget's: a click on a map never moves the caret. */
    ignoreEvent(): boolean {
        return true
    }

    private place(root: HTMLElement, host: HTMLElement): void {
        root.style.paddingLeft = this.indent ?? ''
        host.style.height = `${this.height}px`
    }

    private context(view: EditorView): InteractiveFenceContext {
        const id = this.id
        return {
            ...this.info,
            writable: this.writable,
            dark: this.dark,
            onScreen: this.onScreen,
            presentation: 'inline',
            edit: (change) => applyEdit(view, id, change),
            editAsText: () => showText(view, id),
            remove: () => removeBlock(view, id),
            takeFocus: () => takeFocusRequest(view, id),
            openInTab: () => hostElsewhere(view, id, 'tab'),
            openWindow: () => hostElsewhere(view, id, 'window'),
            closeWindow: () => {},
            resized: () => {
                // Out of the update cycle: a widget may say so while CodeMirror is drawing it.
                queueMicrotask(() => {
                    try {
                        view.dispatch({ effects: fenceResized.of(null) })
                    } catch {
                        // The editor closed in between: nothing is left to measure.
                    }
                })
            },
        }
    }
}

/**
 * The fence with this id in an editor that can still take a widget's change, or null: the editor
 * was closed (its DOM left the page), the document cannot be written, or the fence is gone.
 */
function writableFence(view: EditorView, id: number): InteractiveFenceRange | null {
    const { state } = view
    if (!view.dom.isConnected || state.readOnly || !bodyWritable(state)) return null
    return fenceById(state, id)
}

/** What a widget's change is dispatched to: the editor's view, or a headless editor in tests. */
interface ChangeTarget {
    readonly state: EditorState
    dispatch(tr: Transaction): void
}

/**
 * Dispatch a widget's change, and say whether it went through: a guard may refuse it (the
 * frontmatter guard keeps a document's frontmatter whole), and then the widget must not say it
 * was done.
 */
export function dispatchWidgetChange(target: ChangeTarget, spec: TransactionSpec): boolean {
    const tr = target.state.update(spec)
    target.dispatch(tr)
    return tr.docChanged && refusalIn(tr) === null
}

/** The line changes a widget's edit makes to the fence with this id, or null when it cannot apply. */
export function widgetEditChanges(state: EditorState, id: number, edit: FenceBodyEdit): ChangeSpec | null {
    const fence = fenceById(state, id)
    return fence ? fenceEditChanges(state, fence, edit) : null
}

function applyEdit(view: EditorView, id: number, change: FenceBodyEdit | readonly FenceBodyEdit[]): boolean {
    if (!writableFence(view, id)) return false
    const edits: readonly FenceBodyEdit[] = Array.isArray(change) ? change : [change as FenceBodyEdit]
    if (edits.length === 0) return true
    const changes = edits.length === 1 ? widgetEditChanges(view.state, id, edits[0]) : widgetEditsChanges(view.state, id, edits)
    if (!changes) return false
    return dispatchWidgetChange(view, { changes, userEvent: 'input.fence' })
}

/**
 * A fence put in to take the keyboard (`insertBlock` with `focus`), for each editor: by the fence's
 * id once the insert has been made, and by its opener's line start before, since a widget can be
 * mounted, and ask, inside the very dispatch that wrote its fence.
 */
const focusRequests = new WeakMap<EditorView, { id: number | null; blockFrom: number }>()

/** Ask the widget of the fence opening at `blockFrom` after the next change to take the keyboard. */
export function requestFenceFocus(view: EditorView, blockFrom: number): void {
    focusRequests.set(view, { id: null, blockFrom })
}

/**
 * A request still waiting once the person does something else (types, deletes, moves the caret) is
 * dropped: its widget was not drawn when it was put in (a placeholder, its extension not running, or
 * off screen), and taking the keyboard when it is drawn later would take it from whatever the person
 * is doing then.
 */
const dropStaleFocusRequest = EditorView.updateListener.of((update) => {
    const request = focusRequests.get(update.view)
    if (!request || request.id === null) return
    if (update.transactions.some((tr) => tr.isUserEvent('select') || tr.isUserEvent('input') || tr.isUserEvent('delete'))) focusRequests.delete(update.view)
})

/** The insert landed: the request now names the fence by its id, which survives later edits. */
export function settleFenceFocus(view: EditorView): void {
    const request = focusRequests.get(view)
    if (!request || request.id !== null) return
    const id = fenceIdAt(view.state, request.blockFrom)
    if (id === null) focusRequests.delete(view)
    else focusRequests.set(view, { id, blockFrom: request.blockFrom })
}

function takeFocusRequest(view: EditorView, id: number): boolean {
    const request = focusRequests.get(view)
    if (!request) return false
    const fence = fenceById(view.state, id)
    if (request.id === id || (request.id === null && fence?.blockFrom === request.blockFrom)) {
        focusRequests.delete(view)
        return true
    }
    return false
}

/** Open the fence with this id in a tab or over the window, where its registration can identify it. */
function hostElsewhere(view: EditorView, id: number, where: 'tab' | 'window'): void {
    const fence = fenceById(view.state, id)
    const document = view.state.facet(editorDocument)?.concept
    const hosting = fenceHosting()
    if (!fence || !document || !hosting || !fence.fence.identify) return
    let fenceId: string | null = null
    try {
        fenceId = fence.fence.identify(fence.body)
    } catch (error) {
        console.error(`[extensions] ${fence.info}: identify threw`, error)
    }
    if (!fenceId) return
    const ref = { document, info: fence.info, id: fenceId }
    if (where === 'tab') hosting.openTab(ref)
    else hosting.openWindow(ref)
}

/**
 * The change that deletes a widget's fence. A fence on lines of its own goes with the line break
 * after it; one that ends the document leaves an empty last line where it was rather than taking
 * the line break before it, which may be the frontmatter's closing line, or the end of the bullet
 * the fence belonged to. A form-1 fence is its bullet's content, so it goes from the fence column,
 * leaving the bullet, empty, with its lines and children.
 */
export function fenceRemoval(state: EditorState, fence: InteractiveFenceRange): { from: number; to: number } {
    if (fence.bulletOpener) return { from: fence.blockFrom + fence.fenceColumn, to: fence.blockTo }
    return { from: fence.blockFrom, to: fence.blockTo < state.doc.length ? fence.blockTo + 1 : fence.blockTo }
}

/**
 * Where a caret meant for `pos` rests so it shows no interactive fence's text: `pos` itself, unless
 * an interactive fence holds it (`rangeTouches`) and the caret there would take down its widget and
 * what it held. Then it rests beside that fence: on the line above it, unless that is the
 * frontmatter's closing `---`, which is no place for the caret, and otherwise on the line below.
 * For a caret that is not the person's own choice: after a fence is deleted, where the next fence may
 * now start, and on a line a reveal lands on (Show in document, a Search hit among a map's places).
 */
export function caretBesideFence(state: EditorState, pos: number): number {
    const fences = interactiveFences(state)
    const shows = (at: number) => fences.find((f) => rangeTouches({ from: at, to: at }, f.blockFrom, f.blockTo))
    const there = shows(pos)
    if (!there) return pos
    const body = analysisFor(state).frontmatterEnd
    const beside = [there.blockFrom - 1, there.blockTo + 1].find((at) => at > body && at <= state.doc.length && !shows(at))
    return beside ?? pos
}

function removeBlock(view: EditorView, id: number): boolean {
    const fence = writableFence(view, id)
    if (!fence) return false
    const removal = fenceRemoval(view.state, fence)
    const anchor = caretBesideFence(view.state.update({ changes: removal }).state, removal.from)
    const removed = dispatchWidgetChange(view, { changes: removal, selection: { anchor }, userEvent: 'delete.fence', scrollIntoView: true })
    // The editor takes the keyboard back, so its undo is one keystroke away.
    if (removed) view.focus()
    return removed
}

/**
 * **Edit as text**: the caret at the start of the fence's first body line, at the fence column (or
 * the line's end, for a blank line shorter than that), which shows the fence as text. An empty
 * fence has no line to type on, and the caret anywhere on its fence lines would edit the fence
 * itself, so it is given an empty one at the fence's indentation.
 */
export function editAsTextSpec(state: EditorState, fence: InteractiveFenceRange): TransactionSpec {
    if (fence.body.length === 0) {
        const closer = state.doc.line(fence.end + 1)
        const indent = closer.text.slice(0, fence.fenceColumn)
        return { changes: { from: closer.from, insert: `${indent}\n` }, selection: { anchor: closer.from + indent.length }, scrollIntoView: true, userEvent: 'input' }
    }
    const first = state.doc.line(fence.start + 2)
    return { selection: { anchor: Math.min(first.from + fence.fenceColumn, first.to) }, scrollIntoView: true, userEvent: 'select' }
}

function showText(view: EditorView, id: number): void {
    const fence = fenceById(view.state, id)
    if (!fence) return
    const spec = editAsTextSpec(view.state, fence)
    // An Extension Fence shows its text only when asked (requested-kind reveal), so the request
    // travels with the caret that goes inside it.
    view.dispatch(isExtensionFenceInfo(fence.info) ? { ...spec, effects: requestReveal.of({ from: fence.blockFrom, to: fence.blockTo }) } : spec)
    view.focus()
}

function buildDecorations(state: EditorState): DecorationSet {
    const fences = collapsedInteractiveFences(state)
    if (fences.length === 0) return Decoration.none
    const writable = !state.readOnly && bodyWritable(state)
    const dark = isDark()
    const onScreen = editorIsOnScreen(state)
    const decos: Range<Decoration>[] = []
    for (const f of fences) {
        const id = fenceIdAt(state, f.blockFrom)
        if (id === null) continue
        const info = infoOf(f, state)
        const height = declaredHeight(f.fence, info)
        if (f.bulletOpener) {
            // Form 1: from the fence column, so the bullet's marker stays text and its dot, thread and
            // fold control are drawn as on any bullet, the widget beside the dot (as fence-render.ts).
            const widget = new InteractiveFenceWidget(id, f.fence, info, writable, dark, onScreen, height, true, null)
            decos.push(Decoration.replace({ widget }).range(f.blockFrom + f.fenceColumn, f.blockTo))
        } else {
            const widget = new InteractiveFenceWidget(id, f.fence, info, writable, dark, onScreen, height, false, blockWidgetIndent(state, f.blockFrom))
            decos.push(Decoration.replace({ widget, block: true }).range(f.blockFrom, f.blockTo))
        }
    }
    return Decoration.set(decos, true)
}

/** Whether two states draw the same fences as widgets, by where they open. */
function sameDrawn(a: readonly InteractiveFenceRange[], b: readonly InteractiveFenceRange[]): boolean {
    return a.length === b.length && a.every((fence, i) => fence.blockFrom === b[i].blockFrom)
}

/**
 * The widgets, from the state: CodeMirror needs block widgets, and replaced ranges that span lines,
 * before it measures heights.
 */
const interactiveFenceField = StateField.define<DecorationSet>({
    create: (state) => buildDecorations(state),
    update(deco, tr) {
        const redraw = tr.effects.some((e) => e.is(fenceResized) || e.is(themeTick) || e.is(fenceRegistrationsChanged) || e.is(setEditorOnScreen))
        if (tr.docChanged || tr.reconfigured || redraw) return buildDecorations(tr.state)
        // A caret move redraws only when it shows a fence's text or leaves one, drawing it again.
        if (tr.selection && !sameDrawn(collapsedInteractiveFences(tr.startState), collapsedInteractiveFences(tr.state))) return buildDecorations(tr.state)
        return deco
    },
    provide: (f) => EditorView.decorations.from(f),
})

// High, under the popovers' lists (which bind the same keys at the highest precedence while open)
// and over the view's own motion, as the rendered fences' arrows are (fence-render.ts).
// An Extension Fence is never stepped into: the caret passes over it (`extensionFenceAtoms`).
const arrows = Prec.high(
    keymap.of([
        { key: 'ArrowDown', run: arrowIntoCollapsedFence(1, collapsedOrdinaryFences) },
        { key: 'ArrowUp', run: arrowIntoCollapsedFence(-1, collapsedOrdinaryFences) },
    ]),
)

/** A press on a form-1 fence's line beside its widget (`pressBesideFormOne`); one inside the widget never reaches here. */
const pointer = EditorView.domEventHandlers({
    mousedown: (event, view) => pressBesideFormOne(event, view, collapsedOrdinaryFences),
})

/** A marker for the atomic ranges: CodeMirror reads only where a range sits. */
class AtomMark extends RangeValue {}
const atomMark = new AtomMark()

/**
 * Where the caret may not rest for each drawn [[Extension Fence]] (ADR 0138): from the end of the line
 * above its first line to the start of the line below its last, so the caret's motion, a press and a
 * deletion pass over the fence as one block and land beside it, never on its lines, where a keystroke
 * would write into its data or break its fences. The line breaks either side are part of the range,
 * so the caret's two places beside it are the line above's end and the line below's start, which the
 * range kind leaves drawn.
 */
export function extensionFenceAtomRanges(state: EditorState): RangeSet<AtomMark> {
    const fences = collapsedExtensionFences(state)
    if (fences.length === 0) return RangeSet.empty
    const length = state.doc.length
    return RangeSet.of(
        fences.map((fence) => atomMark.range(Math.max(0, fence.blockFrom - 1), Math.min(length, fence.blockTo + 1))),
        true,
    )
}

const extensionFenceAtoms = EditorView.atomicRanges.of((view) => extensionFenceAtomRanges(view.state))

/** Whether a position lies on a drawn Extension Fence's lines, its first line's start to its last line's end. */
function onExtensionFence(fences: readonly InteractiveFenceRange[], pos: number): InteractiveFenceRange | undefined {
    return fences.find((fence) => pos >= fence.blockFrom && pos <= fence.blockTo)
}

/**
 * Where a caret that would rest on `fence`'s lines goes instead: past it the way the caret was
 * going, to the start of the line below (at its content column, `clampedCaret`) or the end of the
 * line above, and on past every drawn Extension Fence it meets there, as CodeMirror skips adjacent
 * atomic ranges. The other way when there is no line that way: the end of the document, or the
 * frontmatter's closing line above, which is no place for the caret. With no line either way, the
 * fence's edge it came from, where typing starts a line of its own (`extensionFenceEdits`).
 */
export function extensionFenceRestingPlace(state: EditorState, fences: readonly InteractiveFenceRange[], fence: InteractiveFenceRange, down: boolean): number {
    const frontmatterEnd = analysisFor(state).frontmatterEnd
    const past = (start: InteractiveFenceRange, goingDown: boolean): number | null => {
        let current = start
        // Each step passes one more fence, so there are at most as many steps as fences.
        for (let step = 0; step < fences.length; step++) {
            const at = goingDown ? current.blockTo + 1 : current.blockFrom - 1
            if (goingDown ? at > state.doc.length : current.blockFrom === 0 || at <= frontmatterEnd) return null
            const next = onExtensionFence(fences, at)
            if (!next) return goingDown ? clampedCaret(state, at) : at
            current = next
        }
        return null
    }
    return past(fence, down) ?? past(fence, !down) ?? (down ? fence.blockTo : fence.blockFrom)
}

/**
 * Every way a caret is placed that the atomic ranges do not cover (an undo, a reveal, a command's
 * own selection, the caret clamp's ArrowLeft at the wall, a fence at the very start or end of the
 * document, where the atomic range has no line on one side) passes this filter, which moves a caret
 * resting on a drawn Extension Fence's lines past it (`extensionFenceRestingPlace`). A text range
 * that ends on one is widened to take the fence whole, so a selection never cuts into the data.
 *
 * It must see the caret where every other filter has left it, so it is registered at the highest
 * precedence, which CodeMirror runs last (`editor-extensions.test.ts` asserts the order against
 * the caret clamp).
 */
export function extensionFenceCaret(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.selection && tr.changes.empty) return tr
        const state = tr.state
        const fences = collapsedExtensionFences(state)
        if (fences.length === 0) return tr
        let moved = false
        const before = tr.startState.selection.main.head
        const ranges = state.selection.ranges.map((range): SelectionRange => {
            if (range.empty) {
                const fence = onExtensionFence(fences, range.head)
                if (!fence) return range
                // A caret moving down (a key, a press below) goes on past the fence, and one moving
                // up stops above it. One placed by an edit rests above it, as `caretBesideFence`
                // puts a caret after a widget's own change, and below it where there is no line above.
                const down = tr.changes.empty && before <= fence.blockFrom
                const beside = extensionFenceRestingPlace(state, fences, fence, down)
                if (beside === range.head) return range
                moved = true
                return EditorSelection.cursor(beside)
            }
            const forward = range.head >= range.anchor
            const widen = (pos: number, start: boolean) => {
                const fence = onExtensionFence(fences, pos)
                if (!fence) return pos
                moved = true
                return start ? fence.blockFrom : fence.blockTo
            }
            const from = widen(range.from, true)
            const to = widen(range.to, false)
            return forward ? EditorSelection.range(from, to) : EditorSelection.range(to, from)
        })
        if (!moved) return tr
        return [tr, { selection: EditorSelection.create(ranges, state.selection.mainIndex), sequential: true }]
    })
}

/** Whether a change reaches `fence`'s lines without taking the whole fence. */
function changesReach(changes: ChangeSet, fence: InteractiveFenceRange): boolean {
    let reaches = false
    changes.iterChangedRanges((fromA, toA) => {
        if (toA < fence.blockFrom || fromA > fence.blockTo) return
        if (fromA <= fence.blockFrom && toA >= fence.blockTo) return
        reaches = true
    })
    return reaches
}

/**
 * Whether `fence` is still in the transaction's new document, whole: a fence with its info word and
 * its body, where its lines went. Its indentation may change, as when its bullet is indented with
 * the lines around it, since the body is read without it.
 */
function keptWhole(tr: Transaction, fence: InteractiveFenceRange, after: readonly InteractiveFenceRange[]): boolean {
    const from = tr.changes.mapPos(fence.blockFrom, 1)
    const to = tr.changes.mapPos(fence.blockTo, -1)
    return after.some(
        (other) =>
            other.info === fence.info &&
            other.blockFrom <= to &&
            other.blockTo >= from &&
            other.body.length === fence.body.length &&
            other.body.every((line, i) => line === fence.body[i]),
    )
}

/**
 * Text typed or pasted against `fence`'s first line's start or its last line's end, where the caret
 * rests when there is no line beside the fence, moved onto a line of its own above or below it.
 * Null for any other change.
 */
function movedOffFence(tr: Transaction, fence: InteractiveFenceRange): TransactionSpec | null {
    let only: { from: number; to: number; text: string } | null = null
    let count = 0
    tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        count++
        only = { from: fromA, to: toA, text: inserted.toString() }
    })
    const change = only as { from: number; to: number; text: string } | null
    if (count !== 1 || !change || change.from !== change.to || change.text === '') return null
    const userEvent = tr.annotation(Transaction.userEvent)
    if (change.from === fence.blockFrom) {
        return { changes: { from: change.from, insert: `${change.text}\n` }, selection: { anchor: change.from + change.text.length }, userEvent, scrollIntoView: true }
    }
    if (change.from === fence.blockTo) {
        return { changes: { from: change.from, insert: `\n${change.text}` }, selection: { anchor: change.from + change.text.length + 1 }, userEvent, scrollIntoView: true }
    }
    return null
}

/**
 * The last guard of an [[Extension Fence]]'s data (ADR 0138): a person's typing, paste, deletion
 * or drop never breaks a drawn one. The caret rules keep the caret off its lines, and this keeps the
 * fence whole however the caret got there (a document that opens with a fence, where no transaction
 * has placed the caret). An edit that leaves the fence whole passes, its indentation changed or not
 * (a block selection indented with Tab). Text typed or pasted at its edge goes on a line of its own,
 * and any other change that would break it is refused, the keystroke doing nothing.
 *
 * A widget's own edits (`input.fence`), a remote or undo change, and Edit as text's empty line
 * (which carries the request to show the text) are not a person's typing, and pass.
 */
export function extensionFenceEdits(): Extension {
    return EditorState.transactionFilter.of((tr) => {
        if (!tr.docChanged) return tr
        if (!(tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move')) || tr.isUserEvent('input.fence')) return tr
        if (tr.effects.some((effect) => effect.is(requestReveal))) return tr
        const reached = collapsedExtensionFences(tr.startState).filter((fence) => changesReach(tr.changes, fence))
        if (reached.length === 0) return tr
        const after = interactiveFences(tr.state)
        const broken = reached.filter((fence) => !keptWhole(tr, fence, after))
        if (broken.length === 0) return tr
        return (broken.length === 1 ? movedOffFence(tr, broken[0]) : null) ?? []
    })
}

const theme = EditorView.baseTheme({
    // The block's distance from the lines around it, as padding (ADR 0022's height rule): a
    // margin is height the height map never sees.
    '.gk-interactive-fence': { position: 'relative', padding: `${BLOCK_WIDGET_SPACING} 0`, display: 'flow-root', textIndent: '0', whiteSpace: 'normal' },
    // Form 1: beside the bullet's dot, dropped as a bullet image or a rendered fence is there, and as
    // wide as the bullet's text. The marker is lifted out of the line's flow (content-clamp.ts), so
    // the widget starts the line's content box and its whole width fits beside the dot. A margin is
    // height an inline widget's line does measure.
    '.gk-interactive-fence--inline': {
        display: 'inline-block',
        verticalAlign: 'top',
        width: '100%',
        boxSizing: 'border-box',
        margin: `${BULLET_BLOCK_DROP} 0 0`,
        padding: `0 0 ${BLOCK_WIDGET_SPACING}`,
    },
    '.gk-interactive-fence-host': { position: 'relative', overflow: 'hidden' },
    // An Extension Fence nothing draws (extension-fence-placeholder.ts): a quiet note, never its data.
    '.gk-extension-fence-placeholder': {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '0.75rem',
        height: '100%',
        boxSizing: 'border-box',
        padding: '0 0.75rem',
        border: '1px dashed var(--gk-border-strong)',
        borderRadius: '0.5rem',
        color: 'var(--gk-text-muted)',
        fontSize: 'max(0.875rem, 0.85em)',
    },
    '.gk-extension-fence-placeholder p': { margin: '0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    '.gk-extension-fence-placeholder-show': {
        flexShrink: '0',
        border: '1px solid var(--gk-border-strong)',
        borderRadius: '0.375rem',
        padding: '0.25rem 0.625rem',
        background: 'transparent',
        color: 'var(--gk-text-default)',
        font: 'inherit',
        cursor: 'pointer',
    },
})

/**
 * Tell an editor each time a widget for an info word is registered or withdrawn, as the extension
 * that draws it starts or stops (ADR 0121), so its fences are drawn again with no edit in between:
 * switched off, a map shows as its text at once, and switched on, it is drawn as its widget.
 *
 * What it sends is {@link fenceRegistrationsChanged} alone, never a selection, since nothing that
 * follows the caret (the completion menus, the undo grouping) should take it for a caret move. The
 * decorations, the panels and the clamp read the fences again on it, and a caret inside a fence that
 * just became a widget keeps the fence shown as text until it leaves. Kept out of the history.
 *
 * Told on a microtask, never during the registration: a widget's `mount` runs inside its own
 * editor's update, where CodeMirror refuses a dispatch, and an extension can register a widget from
 * there. An editor stopped by then is told nothing. Returns the stop function.
 */
export function followFenceRegistrations(
    registry: ContributionRegistry | null | undefined,
    editor: { readonly state: EditorState; dispatch(tr: Transaction): void },
): () => void {
    let stopped = false
    const unsubscribe =
        registry?.subscribe(INTERACTIVE_FENCE_KIND, () =>
            queueMicrotask(() => {
                if (stopped) return
                const { state } = editor
                editor.dispatch(state.update({ effects: fenceRegistrationsChanged.of(null), annotations: Transaction.addToHistory.of(false) }))
            }),
        ) ?? (() => {})
    return () => {
        stopped = true
        unsubscribe()
    }
}

/** Each open editor follows the registrations of the contribution registry active as it mounts. */
const fenceRegistrations = ViewPlugin.fromClass(
    class {
        private readonly stop: () => void
        constructor(view: EditorView) {
            this.stop = followFenceRegistrations(tryGetActiveContributionRegistry(), view)
        }
        destroy() {
            this.stop()
        }
    },
)

/** The interactive fence augmentation. Mounted in the editor's feature stack (editor-extensions.ts). */
export function interactiveFenceAugmentation(): Extension {
    // The identity before what reads it: the Extension Fences shown as text, then the decorations.
    return [
        fenceIdentity,
        requestedRevealField,
        interactiveFenceField,
        arrows,
        pointer,
        extensionFenceAtoms,
        // Highest precedence runs last among transaction filters, so these see the caret and the
        // changes every other filter has settled. The edit guard is listed second so that it runs
        // first, and the caret filter then places the caret its moved insert left.
        Prec.highest([extensionFenceCaret(), extensionFenceEdits()]),
        dropStaleFocusRequest,
        theme,
        fenceRegistrations,
    ]
}

export type { InteractiveFence }
