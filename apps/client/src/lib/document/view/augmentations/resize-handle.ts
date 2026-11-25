/**
 * The **resize handle** on the bottom-right corner of a rendered picture or video (Logseq's
 * affordance): drag it to set its width, which is written into the display-size hint,
 * `![alt|320](url)` ({@link withDisplayWidth}). The hint is a **maximum** width
 * (image-display-size.ts), so the handle never goes past the widest the owner allows (a picture's
 * natural width, the column), nor below its narrowest.
 *
 * During the drag only the CSS of what is sized changes, with the width read out beside the handle;
 * the document is written once, on release, as one undo step ({@link displayWidthChange}).
 * CodeMirror sees the height change and keeps its height map true during the drag and after a cancel
 * (tests-client/block-widget-height-map.test.ts holds that). Escape, or the pointer being taken
 * away, puts it back as it was. A double click on the handle removes the hint. A `WxH` hint becomes
 * `W`: the handle sizes by width and keeps the aspect ratio.
 *
 * The handle is not focusable: the keyboard route is the hint itself (Editor Content Rules →
 * Selection). It is hidden until its owner raises it: a video's under the pointer, and always where
 * there is no hover (a phone), a picture's once a click or a tap selects the picture
 * (image-select.ts). It is not there at all while the editor is read-only.
 */

import { isolateHistory } from '@codemirror/commands'
import { type EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { parseEmbedLine } from '../../embed-line'
import { editorHistory } from '../editor-history'
import { parseImageDisplaySizeHint, withDisplayWidth } from './image-display-size'

/** The narrowest (px) the handle sizes a picture to. A picture narrower than this is left as it is. */
export const MIN_DISPLAY_WIDTH = 48

/**
 * Below this width or height (px) the handle sits just outside the picture's corner rather than on
 * it: on a small picture the 24px handle would cover the picture, and the pointer over its middle
 * would be over the handle (the wrap's `cm-md-image--small`, set by the widget).
 */
export const HANDLE_INSIDE_MIN = 72

/** The user event of a resize's write. */
export const DISPLAY_RESIZE_USER_EVENT = 'input.resize'

/** How far (px) a drag goes. */
export interface DisplayWidthLimits {
    narrowest: number
    widest: number
}

/** The widest whole pixel the limits allow. */
const upperOf = (limits: DisplayWidthLimits) => Math.max(1, Math.floor(limits.widest))

/**
 * `width` rounded to a whole pixel and kept between `narrowest` and `widest`. Where there is not room
 * for the narrowest, it is the widest.
 */
export function clampDisplayWidth(width: number, limits: DisplayWidthLimits): number {
    return Math.round(Math.min(upperOf(limits), Math.max(limits.narrowest, width)))
}

/**
 * The change that sets the display width of the picture or video on the line holding `pos` to `width`
 * px (or removes the hint, for `null`), as one undo step of its own. Null when the line no longer
 * holds one of `url` (the document changed under the drag) or the hint already says `width`.
 */
export function displayWidthChange(state: EditorState, pos: number, url: string, width: number | null): TransactionSpec | null {
    const line = state.doc.lineAt(pos)
    const embed = parseEmbedLine(line.text)
    if (!embed || embed.url !== url) return null
    const alt = withDisplayWidth(embed.alt, width)
    if (alt === embed.alt) return null
    const from = line.from + embed.imageStart + 2 // past `![`
    // The hint alone: the words stay as they are, with a caret or another member's typing in them.
    const words = parseImageDisplaySizeHint(embed.alt).cleanAlt.length
    return {
        changes: { from: from + words, to: from + embed.alt.length, insert: alt.slice(words) },
        userEvent: DISPLAY_RESIZE_USER_EVENT,
        annotations: isolateHistory.of('full'),
    }
}

export interface ResizeHandleOptions {
    /** The handle's tooltip: what a drag and a double click do here. */
    title: string
    /** The narrowest and the widest (px) a drag goes, asked when the drag starts. */
    limits(): DisplayWidthLimits
    /**
     * What a drag to the widest means: the width it has with no hint, which is then removed and read
     * out in these words. Without it, the widest is a width like any other.
     */
    widestLabel?: string
    /** Write `width` px, or no hint for `null`, into the markdown of what this handle sizes. */
    commit(width: number | null): void
    /**
     * Called when a drag that moved has ended, after any write, for an owner whose height CodeMirror has to be
     * told of: a change during the drag makes it measure the drag's height, and what puts it back
     * may be no transaction at all.
     */
    ended?(): void
}

/** Whether the editor takes edits now: the handle does nothing while it is read-only. */
function writable(view: EditorView): boolean {
    return !view.state.readOnly && view.state.facet(EditorView.editable)
}

/** The diagonal grip lines drawn in the handle, as Logseq and most resizable boxes draw them. */
function gripIcon(): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 12 12')
    svg.setAttribute('width', '12')
    svg.setAttribute('height', '12')
    svg.setAttribute('aria-hidden', 'true')
    const path = document.createElementNS(ns, 'path')
    path.setAttribute('d', 'M11 4 4 11M11 8 8 11')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '1.5')
    path.setAttribute('stroke-linecap', 'round')
    svg.appendChild(path)
    return svg
}

/** The inline sizing of what a handle sizes. */
interface Sizing {
    maxWidth: string
    maxHeight: string
}

const sizingOf = (target: HTMLElement): Sizing => ({ maxWidth: target.style.maxWidth, maxHeight: target.style.maxHeight })

/** One drag of the handle, from the press to its release or cancel. */
interface Drag {
    pointerId: number
    startX: number
    startWidth: number
    limits: DisplayWidthLimits
    width: number
    /** The pointer has moved since the press. */
    moved: boolean
    /** The inline sizing to put back on release or cancel: what the owner last wrote. */
    saved: Sizing
    /** The inline sizing the drag last wrote, which tells its own from the owner's. Null before it wrote any. */
    wrote: Sizing | null
}

/**
 * Put the resize handle and its width readout in `wrap`, over `target`'s bottom-right corner. Where
 * `target` does not fill its wrap, the wrap's `--gk-image-gap-right` and `--gk-image-gap-bottom` say
 * how far in that corner is.
 */
export function attachResizeHandle(view: EditorView, wrap: HTMLElement, target: HTMLElement, options: ResizeHandleOptions): void {
    const handle = document.createElement('span')
    handle.className = 'cm-md-resize-handle'
    handle.title = options.title
    handle.appendChild(gripIcon())
    const readout = document.createElement('span')
    readout.className = 'cm-md-resize-readout'
    readout.setAttribute('aria-hidden', 'true')
    wrap.append(handle, readout)

    let drag: Drag | null = null

    /** Whether the drag is at the widest, where that is the width with no hint. */
    const atDefault = ({ width, limits }: Drag) => options.widestLabel !== undefined && width === upperOf(limits)
    const readOut = (shown: Drag) => {
        readout.textContent = atDefault(shown) ? options.widestLabel! : `${shown.width} px`
    }
    /** Whether the owner sized the target since the drag last did (its hint changed under the drag). */
    const overtaken = ({ saved, wrote }: Drag) => {
        const now = sizingOf(target)
        const last = wrote ?? saved
        return now.maxWidth !== last.maxWidth || now.maxHeight !== last.maxHeight
    }
    const show = (shown: Drag) => {
        // What to put back is the owner's latest, not what stood when the drag began.
        if (overtaken(shown)) shown.saved = sizingOf(target)
        target.style.maxWidth = `${shown.width}px`
        // A `WxH` hint's height would stop a picture growing; the write drops it, so the drag does too.
        target.style.maxHeight = 'none'
        shown.wrote = sizingOf(target)
        readOut(shown)
    }
    /** Put the target back and let go of the pointer and the keyboard. */
    const letGo = (ending: Drag) => {
        drag = null
        if (!overtaken(ending)) Object.assign(target.style, ending.saved)
        if (handle.hasPointerCapture(ending.pointerId)) handle.releasePointerCapture(ending.pointerId)
        wrap.classList.remove('cm-md-resizing')
        window.removeEventListener('keydown', onKey, true)
    }
    /** End the drag with nothing written. */
    const cancel = () => {
        if (!drag) return
        const { moved } = drag
        letGo(drag)
        if (moved) options.ended?.()
    }
    const onKey = (event: KeyboardEvent) => {
        // A handle taken out of the document mid-drag (its widget rebuilt) hears no release, as the
        // pointer's events go to the document then: the drag ends here, and the key is the editor's.
        if (!handle.isConnected) return cancel()
        if (event.key !== 'Escape') return
        // The editor would take Escape as its own (closing a popover, leaving a block selection).
        event.preventDefault()
        event.stopPropagation()
        cancel()
    }

    handle.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || event.button !== 0 || !writable(view)) return
        // Ours, not the editor's: no caret placed, no markdown revealed, no text selected.
        event.preventDefault()
        event.stopPropagation()
        const startWidth = target.getBoundingClientRect().width
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth,
            limits: options.limits(),
            width: Math.round(startWidth),
            moved: false,
            saved: sizingOf(target),
            wrote: null,
        }
        handle.setPointerCapture(event.pointerId)
        wrap.classList.add('cm-md-resizing')
        readOut(drag)
        window.addEventListener('keydown', onKey, true)
    })
    handle.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return
        drag.moved ||= event.clientX !== drag.startX
        // The pointer resting where it was pressed has sized nothing.
        if (!drag.moved) return
        drag.width = clampDisplayWidth(drag.startWidth + event.clientX - drag.startX, drag.limits)
        show(drag)
    })
    handle.addEventListener('pointerup', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return
        const ending = drag
        letGo(ending)
        // A press without a drag (half of a double click) writes nothing. Nor does a drag back to where
        // it began, unless that is the default: a hint past the column's edge is drawn at the edge too.
        const toDefault = ending.moved && atDefault(ending)
        if (toDefault || ending.width !== Math.round(ending.startWidth)) commitAsOwnStep(view, () => options.commit(toDefault ? null : ending.width))
        if (ending.moved) options.ended?.()
    })
    handle.addEventListener('pointercancel', cancel)
    handle.addEventListener('lostpointercapture', cancel)
    handle.addEventListener('dblclick', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (writable(view)) commitAsOwnStep(view, () => options.commit(null))
    })
    // The compatibility mouse events a press makes stay out of the editor, which would otherwise
    // reveal the markdown under the handle (image-embed.ts's widget handler).
    handle.addEventListener('mousedown', (event) => event.stopPropagation())
}

/**
 * Run `write` as an undo step of its own on either history: the annotation closes it on the local
 * one, and the collaborative one, which groups by time, is told before and after.
 */
function commitAsOwnStep(view: EditorView, write: () => void): void {
    const history = view.state.facet(editorHistory)
    history.closeStep?.()
    write()
    history.closeStep?.()
}

/** The handle and readout's look. Text in the readout is 14px, as all reading text is (ADR 0106). */
export const resizeHandleTheme = EditorView.baseTheme({
    '.cm-md-resize-handle': {
        position: 'absolute',
        right: 'calc(var(--gk-image-gap-right, 0px) + 2px)',
        bottom: 'calc(var(--gk-image-gap-bottom, 0px) + 2px)',
        // A 24px target around a smaller drawn grip.
        width: '24px',
        height: '24px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '5px',
        color: 'var(--gk-text-default, #262626)',
        background: 'var(--gk-surface-1, rgba(255,255,255,0.92))',
        border: '1px solid var(--gk-border-soft, rgba(0,0,0,0.12))',
        boxShadow: 'var(--gk-shadow, 0 1px 3px rgba(0,0,0,0.25))',
        cursor: 'nwse-resize',
        // The page must not scroll or zoom under a finger dragging the handle.
        touchAction: 'none',
        opacity: '0',
        pointerEvents: 'none',
        transition: 'opacity 120ms ease',
    },
    '.cm-md-resizing .cm-md-resize-handle': {
        opacity: '1',
        pointerEvents: 'auto',
    },
    // No hover to reveal it on a phone, so there it always shows.
    '@media (hover: none)': {
        '.cm-md-resize-handle': { opacity: '1', pointerEvents: 'auto' },
    },
    // Read-only: nothing to write, so nothing to offer.
    '.cm-content[contenteditable="false"] .cm-md-resize-handle': { display: 'none' },
    '.cm-md-resize-readout': {
        position: 'absolute',
        right: 'calc(var(--gk-image-gap-right, 0px) + 32px)',
        bottom: 'calc(var(--gk-image-gap-bottom, 0px) + 2px)',
        display: 'none',
        padding: '1px 6px',
        borderRadius: '4px',
        fontSize: '14px',
        lineHeight: '22px',
        fontVariantNumeric: 'tabular-nums',
        color: 'var(--gk-text-default, #262626)',
        background: 'var(--gk-surface-1, rgba(255,255,255,0.92))',
        border: '1px solid var(--gk-border-soft, rgba(0,0,0,0.12))',
        pointerEvents: 'none',
    },
    '.cm-md-resizing .cm-md-resize-readout': { display: 'block' },
    '@media (prefers-reduced-motion: reduce)': {
        '.cm-md-resize-handle': { transition: 'none' },
    },
})
