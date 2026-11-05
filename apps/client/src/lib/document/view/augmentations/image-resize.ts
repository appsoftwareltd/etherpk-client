/**
 * The **resize handle** on a rendered image's bottom-right corner (Logseq's affordance): drag it to
 * size the picture, and the width is written into the image's display-size hint, `![alt|320](url)`
 * ({@link withDisplayWidth}). The hint keeps its meaning, a **maximum** width (image-display-size.ts),
 * so the handle never takes a picture past its natural width or its column, and never below
 * {@link MIN_DISPLAY_WIDTH}.
 *
 * During the drag only the picture's CSS changes, with the width read out beside the handle; the
 * document is written once, on release, as one undo step ({@link imageWidthChange}). CodeMirror sees
 * the picture's height change and keeps its height map true during the drag and after a cancel
 * (tests-client/block-widget-height-map.test.ts holds that). Escape, or the
 * pointer being taken away, puts the picture back as it was. A double click on the handle removes
 * the hint, so the picture shows at its natural size again. A `WxH` hint becomes `W`: the handle
 * sizes by width and keeps the aspect ratio.
 *
 * The handle is not focusable: the keyboard route is the hint itself, which a click on the picture
 * reveals with the caret just after it (Editor Content Rules → Selection). It shows while the
 * pointer is over the picture, and always where there is no hover (a phone), and not at all while
 * the editor is read-only.
 */

import { isolateHistory } from '@codemirror/commands'
import { type EditorState, type TransactionSpec } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

import { parseImageLine } from '../../image-line'
import { editorHistory } from '../editor-history'
import { withDisplayWidth } from './image-display-size'

/** The narrowest (px) the handle sizes a picture to. A picture narrower than this is left as it is. */
export const MIN_DISPLAY_WIDTH = 48

/**
 * Below this width or height (px) the handle sits just outside the picture's corner rather than on
 * it: on a small picture the 24px handle would cover the picture, and the pointer over its middle
 * would be over the handle (the wrap's `cm-md-image--small`, set by the widget).
 */
export const HANDLE_INSIDE_MIN = 72

/** The user event of a resize's write. */
export const IMAGE_RESIZE_USER_EVENT = 'input.resize'

/**
 * `width` rounded to a whole pixel and kept between {@link MIN_DISPLAY_WIDTH} and the narrower of the
 * picture's natural width and its column: the hint is a maximum, so a width past the natural one
 * would write a number the picture cannot show.
 */
export function clampDisplayWidth(width: number, natural: number, column: number): number {
    const upper = Math.max(1, Math.floor(Math.min(natural, column)))
    const lower = Math.min(MIN_DISPLAY_WIDTH, upper)
    return Math.round(Math.min(upper, Math.max(lower, width)))
}

/**
 * The change that sets the display width of the image on the line holding `pos` to `width` px (or
 * removes the hint, for `null`), as one undo step of its own. Null when the line no longer holds an
 * image of `url` (the document changed under the drag) or the hint already says `width`.
 */
export function imageWidthChange(state: EditorState, pos: number, url: string, width: number | null): TransactionSpec | null {
    const line = state.doc.lineAt(pos)
    const image = parseImageLine(line.text)
    if (!image || image.url !== url) return null
    const alt = withDisplayWidth(image.alt, width)
    if (alt === image.alt) return null
    const from = line.from + image.imageStart + 2 // past `![`
    return {
        changes: { from, to: from + image.alt.length, insert: alt },
        userEvent: IMAGE_RESIZE_USER_EVENT,
        annotations: isolateHistory.of('full'),
    }
}

export interface ResizeHandleOptions {
    /** Write `width` px, or no hint for `null`, into the image this handle sits on. */
    commit(width: number | null): void
}

/** Whether the editor takes edits now: the handle does nothing while it is read-only. */
function writable(view: EditorView): boolean {
    return !view.state.readOnly && view.state.facet(EditorView.editable)
}

/** The width (px) the picture may take: from its left edge to the right of its line's text column. */
function columnWidth(wrap: HTMLElement, img: HTMLImageElement): number {
    const column = wrap.closest('.cm-line') ?? wrap
    const right = column.getBoundingClientRect().right - (parseFloat(getComputedStyle(column).paddingRight) || 0)
    return right - img.getBoundingClientRect().left
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

/** One drag of the handle, from the press to its release or cancel. */
interface Drag {
    pointerId: number
    startX: number
    startWidth: number
    natural: number
    column: number
    width: number
    /** The picture's inline sizing before the drag, put back on release or cancel. */
    saved: { maxWidth: string; maxHeight: string }
}

/**
 * Put the resize handle and its width readout in `wrap`, over `img`'s bottom-right corner (the
 * `--gk-image-gap-right` and `--gk-image-gap-bottom` the widget keeps on the wrap place it there).
 * Returns the handle, so the widget can count the pointer over it as over the picture.
 */
export function attachResizeHandle(view: EditorView, wrap: HTMLElement, img: HTMLImageElement, options: ResizeHandleOptions): HTMLElement {
    const handle = document.createElement('span')
    handle.className = 'cm-md-image-resize'
    handle.title = 'Drag to resize. Double-click for the original size.'
    handle.appendChild(gripIcon())
    const readout = document.createElement('span')
    readout.className = 'cm-md-image-resize-readout'
    readout.setAttribute('aria-hidden', 'true')
    wrap.append(handle, readout)

    let drag: Drag | null = null

    const show = (width: number) => {
        img.style.maxWidth = `${width}px`
        // A `WxH` hint's height would stop the picture growing; the write drops it, so the drag does too.
        img.style.maxHeight = 'none'
        readout.textContent = `${width} px`
    }
    /** Put the picture back and let go of the pointer and the keyboard. */
    const end = () => {
        if (!drag) return
        img.style.maxWidth = drag.saved.maxWidth
        img.style.maxHeight = drag.saved.maxHeight
        if (handle.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId)
        wrap.classList.remove('cm-md-image--resizing')
        window.removeEventListener('keydown', onKey, true)
        drag = null
    }
    const onKey = (event: KeyboardEvent) => {
        // A handle taken out of the document mid-drag (its widget rebuilt) hears no release, as the
        // pointer's events go to the document then: the drag ends here, and the key is the editor's.
        if (!handle.isConnected) return end()
        if (event.key !== 'Escape') return
        // The editor would take Escape as its own (closing a popover, leaving a block selection).
        event.preventDefault()
        event.stopPropagation()
        end()
    }

    handle.addEventListener('pointerdown', (event) => {
        if (!event.isPrimary || event.button !== 0 || !writable(view)) return
        // Ours, not the editor's: no caret placed, no markdown revealed, no text selected.
        event.preventDefault()
        event.stopPropagation()
        const startWidth = img.getBoundingClientRect().width
        drag = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startWidth,
            natural: img.naturalWidth || startWidth,
            column: columnWidth(wrap, img),
            width: Math.round(startWidth),
            saved: { maxWidth: img.style.maxWidth, maxHeight: img.style.maxHeight },
        }
        handle.setPointerCapture(event.pointerId)
        wrap.classList.add('cm-md-image--resizing')
        readout.textContent = `${drag.width} px`
        window.addEventListener('keydown', onKey, true)
    })
    handle.addEventListener('pointermove', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return
        drag.width = clampDisplayWidth(drag.startWidth + event.clientX - drag.startX, drag.natural, drag.column)
        show(drag.width)
    })
    handle.addEventListener('pointerup', (event) => {
        if (!drag || event.pointerId !== drag.pointerId) return
        const { width, startWidth } = drag
        end()
        // A press without a drag (half of a double click) writes nothing.
        if (width !== Math.round(startWidth)) commitAsOwnStep(view, () => options.commit(width))
    })
    handle.addEventListener('pointercancel', end)
    handle.addEventListener('lostpointercapture', end)
    handle.addEventListener('dblclick', (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (writable(view)) commitAsOwnStep(view, () => options.commit(null))
    })
    // The compatibility mouse events a press makes stay out of the editor, which would otherwise
    // reveal the markdown under the handle (image-embed.ts's widget handler).
    handle.addEventListener('mousedown', (event) => event.stopPropagation())
    return handle
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
export const imageResizeTheme = EditorView.baseTheme({
    '.cm-md-image-resize': {
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
    // Outside a small picture's corner, overlapping it by 4px so the pointer passes straight onto it.
    '.cm-md-image--small .cm-md-image-resize': {
        right: 'calc(var(--gk-image-gap-right, 0px) - 20px)',
        bottom: 'calc(var(--gk-image-gap-bottom, 0px) - 20px)',
    },
    '.cm-md-image--hovered .cm-md-image-resize, .cm-md-image--resizing .cm-md-image-resize': {
        opacity: '1',
        pointerEvents: 'auto',
    },
    // No hover to reveal it on a phone, so there it always shows.
    '@media (hover: none)': {
        '.cm-md-image-resize': { opacity: '1', pointerEvents: 'auto' },
    },
    // Read-only: nothing to write, so nothing to offer.
    '.cm-content[contenteditable="false"] .cm-md-image-resize': { display: 'none' },
    '.cm-md-image-resize-readout': {
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
    '.cm-md-image--resizing .cm-md-image-resize-readout': { display: 'block' },
    '@media (prefers-reduced-motion: reduce)': {
        '.cm-md-image-resize': { transition: 'none' },
    },
})
