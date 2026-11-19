/**
 * Augmentation: a bullet's dot and the chevron beside it as its controls (Editor Content Rules →
 * Folds; the plan "Bullet Context Actions").
 *
 * - A click or tap on the dot of a bullet with children folds or unfolds it.
 * - While the mouse is over a row whose bullet has children, a chevron is drawn left of the dot,
 *   pointing down when open and right when folded. A click on it folds or unfolds, as the dot does.
 *   A device with no pointer never shows it, so the dot is the control there.
 * - A right-click on the dot, a long press on it on a touch screen, or Mod+Shift+. in the bullet,
 *   opens the block menu. A long press on a task's checkbox opens the line menu, which carries the
 *   task's rows; a long press on text stays the browser's text selection.
 *
 * The dot's own drawing (its disc on hover and when folded) is bullet-marker.ts. The chevron is a
 * layer marker, like a bookmark, so nothing is added to the text's DOM; its clicks are found by
 * position, since the layer takes no pointer events.
 */

import { foldedRanges } from '@codemirror/language'
import { type EditorState, type Extension, Prec, StateEffect, StateField } from '@codemirror/state'
import { EditorView, keymap, layer, RectangleMarker } from '@codemirror/view'

import { isBulletLine, lineIndent } from '../../outliner'
import { analysisFor } from '../analysis/editor-analysis'
import { lineShownIn } from '../shown-range'
import { anchorBlockMenu, blockMenuAnchor } from '../block-menu-anchor'
import { allFolds, isFoldableBullet, isFoldedBullet, toggleBulletFoldSpec } from './outline-folds'

/** A line a menu opens on: its 1-based number and its text when the menu opened. */
export interface MenuLine {
    number: number
    text: string
}

export interface FoldControlOptions {
    /**
     * Open the block menu for the bullet on `line` at viewport `x`/`y`; `touch` when a long press
     * opened it. Absent, the dot opens none.
     */
    blockMenu?: (line: MenuLine, x: number, y: number, touch: boolean) => void
    /** Open the line menu for `line` (a long press on a task's checkbox). */
    lineMenu?: (line: MenuLine, x: number, y: number) => void
}

/** How long a touch must rest on the dot or a checkbox to open its menu, as a browser's own long press. */
export const LONG_PRESS_MS = 500
/** How far a touch may drift before it is a scroll, not a press. */
const LONG_PRESS_SLOP_PX = 10
/** The chevron's centre, this far left of the dot's centre: the width of the fold column (app.css). */
const CHEVRON_OFFSET_EM = 1
/** The chevron's drawn size and its hit area, as fractions of the editor's font size. */
const CHEVRON_SIZE_EM = 0.625
const CHEVRON_HIT_EM = 1.25

const setHoverRow = StateEffect.define<number | null>()
const setHoverDot = StateEffect.define<number | null>()
const setHoverChevron = StateEffect.define<number | null>()

function hoverFieldOf(effect: typeof setHoverRow) {
    return StateField.define<number | null>({
        create: () => null,
        update(value, tr) {
            let next = value
            for (const e of tr.effects) if (e.is(effect)) next = e.value
            return tr.docChanged ? null : next
        },
    })
}

/** The 1-based line of the bullet whose row the mouse is over, while it has children: where the chevron shows. */
const hoverRowField = hoverFieldOf(setHoverRow)

/** The 1-based line of the bullet whose dot the mouse is over: its disc is drawn, and its guide starts lower. */
export const hoverDotField = hoverFieldOf(setHoverDot)

/** The 1-based line of the bullet whose chevron the mouse is on: the pointer shows the chevron is a control. */
const hoverChevronField = hoverFieldOf(setHoverChevron)

/**
 * The pointer cursor while the mouse is on the chevron, as on the dot. The chevron is drawn in a layer
 * that takes no pointer events, so the cursor is the text's own: the class goes on the text.
 */
const chevronCursor = EditorView.contentAttributes.compute([hoverChevronField], (state): Record<string, string> =>
    state.field(hoverChevronField) === null ? {} : { class: 'gk-fold-chevron-hover' },
)

/** The 1-based line of the dot under the mouse, read by the outline guides; null outside the feature. */
export function hoveredDotLine(state: EditorState): number | null {
    return state.field(hoverDotField, false) ?? null
}

const optionsField = StateField.define<FoldControlOptions>({ create: () => ({}), update: (v) => v })

/**
 * The bullet line (1-based) a mouse row shows the chevron for: the bullet whose block the row is in,
 * when it has children. None for a line an editor showing part of its document hides (`shown-range.ts`):
 * above the first line the [[Task Editor]] shows and below its last, the mouse is over hidden lines,
 * which have no place on screen for a chevron.
 */
export function chevronLine(state: EditorState, line: number): number | null {
    const { outline, branchEnds } = analysisFor(state)
    const owner = outline[line - 1]?.owner ?? -1
    if (owner < 0 || branchEnds[owner] <= owner) return null
    return lineShownIn(state, line) && lineShownIn(state, owner + 1) ? owner + 1 : null
}

/** The centre (viewport px) of the dot on bullet line `line`, or null when it is not laid out. */
function dotCentre(view: EditorView, line: number): { x: number; y: number } | null {
    const { from, text } = view.state.doc.line(line)
    if (!isBulletLine(text)) return null
    const marker = from + lineIndent(text)
    const a = view.coordsAtPos(marker)
    const b = view.coordsAtPos(marker + 1, -1)
    return a && b ? { x: (a.left + b.left) / 2, y: (a.top + a.bottom) / 2 } : null
}

function fontPx(view: EditorView): number {
    return parseFloat(getComputedStyle(view.contentDOM).fontSize) || 16
}

/** The chevron's centre (viewport px) for bullet line `line`. */
function chevronCentre(view: EditorView, line: number): { x: number; y: number } | null {
    const dot = dotCentre(view, line)
    return dot ? { x: dot.x - CHEVRON_OFFSET_EM * fontPx(view), y: dot.y } : null
}

/** Whether the hovered row's bullet was folded or unfolded: its chevron turns. Asked only while a row is hovered. */
function hoveredFoldChanged(before: EditorState, after: EditorState): boolean {
    const line = after.field(hoverRowField)
    if (line === null || foldedRanges(before) === foldedRanges(after)) return false
    return isFoldedBullet(before, line) !== isFoldedBullet(after, line)
}

/**
 * Whether there is room for a chevron left of the text: the fold column (app.css), which the Phone
 * Layout and a screen with no hover do not keep. Without it a top-level bullet's chevron would sit
 * over the bookmark padding and take its clicks, so none is drawn.
 */
function hasFoldColumn(view: EditorView): boolean {
    return (parseFloat(getComputedStyle(view.contentDOM).getPropertyValue('--gk-fold-column')) || 0) > 0
}

const chevronLayer = layer({
    above: true,
    class: 'gk-fold-chevron-layer',
    markers(view) {
        const line = view.state.field(hoverRowField)
        if (line === null || line > view.state.doc.lines || !hasFoldColumn(view)) return []
        const centre = chevronCentre(view, line)
        if (!centre) return []
        const scroller = view.scrollDOM.getBoundingClientRect()
        const originLeft = scroller.left - view.scrollDOM.scrollLeft * view.scaleX
        const originTop = scroller.top - view.scrollDOM.scrollTop * view.scaleY
        const size = Math.round(CHEVRON_SIZE_EM * fontPx(view))
        const cls = isFoldedBullet(view.state, line) ? 'gk-fold-chevron gk-fold-chevron--folded' : 'gk-fold-chevron'
        return [new RectangleMarker(cls, centre.x - size / 2 - originLeft, centre.y - size / 2 - originTop, size, size)]
    },
    update: (update) =>
        update.docChanged ||
        update.viewportChanged ||
        update.geometryChanged ||
        update.startState.field(hoverRowField) !== update.state.field(hoverRowField) ||
        hoveredFoldChanged(update.startState, update.state),
})

/** The 1-based line of the bullet whose dot `target` is, or null. */
function dotLineOf(view: EditorView, target: EventTarget | null): number | null {
    const dot = target instanceof Element ? target.closest('.cm-bullet-dot') : null
    if (!dot || !view.contentDOM.contains(dot)) return null
    const line = view.state.doc.lineAt(view.posAtDOM(dot)).number
    return isBulletLine(view.state.doc.line(line).text) ? line : null
}

/** The 1-based line of the task whose checkbox `target` is, or null. */
function checkboxLineOf(view: EditorView, target: EventTarget | null): number | null {
    const box = target instanceof Element ? target.closest('.cm-task-checkbox') : null
    if (!box || !view.contentDOM.contains(box)) return null
    return view.state.doc.lineAt(view.posAtDOM(box)).number
}

/** Whether the viewport point is on the chevron drawn for the hovered row; returns that row's line. */
function chevronHit(view: EditorView, x: number, y: number): number | null {
    const line = view.state.field(hoverRowField)
    if (line === null || line > view.state.doc.lines || !hasFoldColumn(view)) return null
    const centre = chevronCentre(view, line)
    if (!centre) return null
    const half = (CHEVRON_HIT_EM * fontPx(view)) / 2
    return Math.abs(x - centre.x) <= half && Math.abs(y - centre.y) <= half ? line : null
}

function toggle(view: EditorView, line: number): boolean {
    const spec = toggleBulletFoldSpec(view.state, line)
    if (!spec) return false
    view.dispatch(spec)
    return true
}

/** Tell the editor which bullet the block menu about to open is for, so its rows find it after a peer's edit. */
function anchorMenu(view: EditorView, line: number): void {
    view.dispatch({ effects: anchorBlockMenu.of(line) })
}

function menuLine(state: EditorState, line: number): MenuLine {
    return { number: line, text: state.doc.line(line).text }
}

/** The bullet line the mouse's row belongs to, for the chevron, by its height in the document. */
function rowLineAt(view: EditorView, y: number): number | null {
    const block = view.lineBlockAtHeight(y - view.documentTop)
    if (block.from > view.state.doc.length) return null
    return chevronLine(view.state, view.state.doc.lineAt(block.from).number)
}

/** A touch held on the dot or a checkbox, waiting to become a long press. */
interface PendingPress {
    pointerId: number
    x: number
    y: number
    timer: ReturnType<typeof setTimeout>
}

const pressField = new WeakMap<EditorView, PendingPress>()
/** Until when a mousedown after a long press is the press's own and ignored (ms since epoch). */
const swallowUntil = new WeakMap<EditorView, number>()

function cancelPress(view: EditorView): void {
    const pending = pressField.get(view)
    if (pending) clearTimeout(pending.timer)
    pressField.delete(view)
}

function dispatchHover(view: EditorView, row: number | null, dot: number | null, chevron: number | null): void {
    const effects: StateEffect<number | null>[] = []
    if (view.state.field(hoverRowField) !== row) effects.push(setHoverRow.of(row))
    if (view.state.field(hoverDotField) !== dot) effects.push(setHoverDot.of(dot))
    if (view.state.field(hoverChevronField) !== chevron) effects.push(setHoverChevron.of(chevron))
    if (effects.length) view.dispatch({ effects })
}

const handlers = EditorView.domEventHandlers({
    pointermove(event, view) {
        if (event.pointerType === 'touch') {
            const pending = pressField.get(view)
            if (pending && Math.hypot(event.clientX - pending.x, event.clientY - pending.y) > LONG_PRESS_SLOP_PX) cancelPress(view)
            return false
        }
        const dot = dotLineOf(view, event.target)
        // While on the chevron, the row stays the one it was drawn for, whatever row the height says.
        const chevron = chevronHit(view, event.clientX, event.clientY)
        dispatchHover(view, chevron ?? rowLineAt(view, event.clientY), dot, chevron)
        return false
    },
    mouseleave(_event, view) {
        dispatchHover(view, null, null, null)
        return false
    },
    pointerdown(event, view) {
        if (event.pointerType !== 'touch') return false
        const options = view.state.field(optionsField)
        const dot = dotLineOf(view, event.target)
        const box = dot === null ? checkboxLineOf(view, event.target) : null
        const { blockMenu, lineMenu } = options
        const open =
            dot !== null && blockMenu
                ? (line: MenuLine, x: number, y: number) => {
                      anchorMenu(view, line.number)
                      blockMenu(line, x, y, true)
                  }
                : box !== null
                  ? lineMenu
                  : undefined
        const line = dot ?? box
        if (!open || line === null) return false
        cancelPress(view)
        const { clientX: x, clientY: y, pointerId } = event
        const timer = setTimeout(() => {
            pressField.delete(view)
            swallowUntil.set(view, Date.now() + 1000)
            open(menuLine(view.state, line), x, y)
        }, LONG_PRESS_MS)
        pressField.set(view, { pointerId, x, y, timer })
        return false
    },
    pointerup(_event, view) {
        cancelPress(view)
        return false
    },
    pointercancel(_event, view) {
        cancelPress(view)
        return false
    },
    mousedown(event, view) {
        // The compatibility mousedown a long press can leave behind is the press's, not a tap.
        if (afterLongPress(view)) {
            swallowUntil.delete(view)
            event.preventDefault()
            return true
        }
        return plainPrimary(event) && (pressControl(view, event) || pressBesideFold(view, event))
    },
    contextmenu(event, view) {
        // Chrome raises the context menu as a PointerEvent, which says what raised it. A touch's menu
        // comes from its own timer, so the browser's would only cover ours.
        const touch = (event as Partial<PointerEvent>).pointerType === 'touch' || pressField.has(view) || afterLongPress(view)
        const dot = dotLineOf(view, event.target)
        if (dot === null) {
            if (!touch || checkboxLineOf(view, event.target) === null) return false
            event.preventDefault()
            return true
        }
        event.preventDefault()
        const blockMenu = view.state.field(optionsField).blockMenu
        if (!touch && blockMenu) {
            anchorMenu(view, dot)
            blockMenu(menuLine(view.state, dot), event.clientX, event.clientY, false)
        }
        return true
    },
})

/** Whether a long press opened a menu a moment ago, whose leftover events are its own. */
function afterLongPress(view: EditorView): boolean {
    return (swallowUntil.get(view) ?? 0) > Date.now()
}

/** A primary-button press with no modifier: what a click on a control is. */
function plainPrimary(event: MouseEvent): boolean {
    return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey
}

/** A press on the chevron folds at once; one on a parent's dot waits to see whether it is a click. */
function pressControl(view: EditorView, event: MouseEvent): boolean {
    const chevron = chevronHit(view, event.clientX, event.clientY)
    if (chevron !== null && isFoldableBullet(view.state, chevron)) {
        // Neither a caret move nor focus: the chevron is a control, not text.
        event.preventDefault()
        toggle(view, chevron)
        return true
    }
    const dot = dotLineOf(view, event.target)
    if (dot === null || !isFoldableBullet(view.state, dot)) return false
    event.preventDefault()
    clickOrDrag(view, event, dot)
    return true
}

/**
 * A press in the empty room right of a folded bullet's text: the caret goes to the end of that text
 * and the fold stays. Taken from CodeMirror, which has no one answer for that place: the hidden
 * lines' placeholder sits there, and the press was read as the end of the hidden text (which opened
 * the fold with the caret at the foot of the branch), or as two places at once, which selected the
 * bullet's text or the whole hidden branch. Judged by where the press is, right of the end of the
 * text on the folded bullet's row, not by the position the browser gives it.
 */
function pressBesideFold(view: EditorView, event: MouseEvent): boolean {
    if (event.detail > 1) return false
    const block = view.lineBlockAtHeight(event.clientY - view.documentTop)
    const fold = allFolds(view.state).find((f) => f.from >= block.from && f.from <= block.to && view.state.doc.lineAt(f.from).to === f.from)
    if (!fold) return false
    const end = view.coordsAtPos(fold.from, -1)
    if (!end || event.clientX < end.right || event.clientY < end.top || event.clientY > end.bottom) return false
    event.preventDefault()
    view.focus()
    view.dispatch({ selection: { anchor: fold.from }, userEvent: 'select.pointer', scrollIntoView: true })
    return true
}

/** How far the mouse may move from where it went down on a dot and still be a click. */
const CLICK_SLOP_PX = 4

/**
 * A press on a dot: a click folds or unfolds its bullet; a drag that starts there selects text, as a
 * drag from the start of the line would, since the dot's own mousedown is kept from CodeMirror so a
 * click places no caret.
 */
function clickOrDrag(view: EditorView, down: MouseEvent, line: number): void {
    const anchor = view.state.doc.line(line).from
    let dragging = false
    const move = (event: MouseEvent) => {
        if (!dragging && Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) < CLICK_SLOP_PX) return
        if (!dragging) {
            dragging = true
            view.focus()
        }
        const head = view.posAtCoords({ x: event.clientX, y: event.clientY }, false)
        view.dispatch({ selection: { anchor, head }, userEvent: 'select.pointer' })
    }
    const up = () => {
        document.removeEventListener('mousemove', move)
        document.removeEventListener('mouseup', up)
        if (!dragging) toggle(view, Math.min(line, view.state.doc.lines))
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
}

/** Mod+Shift+. opens the block menu of the bullet the caret is in, under the bullet's dot. */
function blockMenuAtCaret(view: EditorView): boolean {
    const open = view.state.field(optionsField).blockMenu
    if (!open) return false
    const { state } = view
    // The analysis's own bullets only: a bullet-shaped line in code or the frontmatter has no block.
    const { outline, branchEnds } = analysisFor(state)
    const owner = outline[state.doc.lineAt(state.selection.main.head).number - 1]?.owner ?? -1
    if (owner < 0 || branchEnds[owner] < 0) return true
    const dot = dotCentre(view, owner + 1)
    const at = dot ?? (() => {
        const c = view.coordsAtPos(state.selection.main.head)
        return c ? { x: c.left, y: c.bottom } : null
    })()
    if (!at) return true
    anchorMenu(view, owner + 1)
    open(menuLine(state, owner + 1), at.x, at.y + 8, false)
    return true
}

const theme = EditorView.baseTheme({
    '.gk-fold-chevron-layer': { pointerEvents: 'none' },
    // A small filled triangle, in the dot's colour: pointing down over an open bullet, right over a
    // folded one.
    '.gk-fold-chevron': {
        backgroundColor: 'var(--gk-text-subtle, #525252)',
        clipPath: 'polygon(10% 25%, 90% 25%, 50% 80%)',
    },
    '.gk-fold-chevron.gk-fold-chevron--folded': { clipPath: 'polygon(25% 10%, 80% 50%, 25% 90%)' },
    '.cm-content.gk-fold-chevron-hover': { cursor: 'pointer' },
})

/** The fold controls. `options` come from the editor that mounts it. */
export function foldControlsAugmentation(options: FoldControlOptions = {}): Extension {
    return [
        optionsField.init(() => options),
        blockMenuAnchor(),
        hoverRowField,
        hoverDotField,
        hoverChevronField,
        chevronCursor,
        chevronLayer,
        // Before the bookmarks' and the checkbox's own handlers, which would take the same events.
        Prec.high(handlers),
        Prec.high(keymap.of([{ key: 'Mod-Shift-.', run: blockMenuAtCaret, preventDefault: true }])),
        theme,
    ]
}
