/**
 * Keeping the reading point still in a journal tab's scroller while what is above it changes
 * height ([[Journal Roll]], ADR 0136).
 *
 * The scroller holds the tab's editor, its backlinks section and the roll's older days, each an
 * editor of its own. CodeMirror keeps the reading point still for its own editor's changes, but in a
 * scroller that is not its own only while it has the focus or has just had a wheel or touch, and the
 * scroller sets `overflow-anchor: none`, so the browser does not either. An edit arriving by sync in
 * an older day above the reader, a picture loading in one, or the tab's backlinks gaining a group
 * moved everything the reader was looking at.
 *
 * So the keeper remembers where the reader is: the first day block, in order, that crosses or sits
 * below the visible top, and for a day whose text crosses it, the position in that text at the top.
 * When anything it watches changes size, it scrolls by however far that point moved. It leaves
 * alone a point inside the editor that has the focus, where CodeMirror does the work. A reader still
 * in the tab's own text has nothing to keep: what changes beneath that text (the [[Journal Panel]]s,
 * the backlinks) is below them, and keeping a roll block still there would scroll their text away.
 */

import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

/**
 * The reader's position in each older day's text, carried through the edits that day receives.
 * A position is an offset, and an edit above it (a line arriving by sync at the top of the day)
 * moves the text it named: without this, the keeper looked for the reader at an offset that now
 * held other text, saw nothing move, and left the reader's lines to slide away.
 */
const anchors = new WeakMap<EditorView, { pos: number }>()

/** For an older day's editor (DocumentView in rolled mode): keep its reading position mapped. */
export const followReadingPoint: Extension = EditorView.updateListener.of((update) => {
    const anchor = anchors.get(update.view)
    if (anchor && update.docChanged) anchor.pos = update.changes.mapPos(anchor.pos, -1)
})

/** Where the reader is, and how to find it again. */
interface ReadingMark {
    /** Its client y when remembered. */
    top: number
    /** Its client y now, or null once it has gone. */
    now(): number | null
    /** Whether the editor holding it has the focus. */
    focused(): boolean
}

export interface ReadingPointKeeper {
    /** The scroller to keep still; the tab's, handed over with each editor it builds. */
    setScroller(scroller: HTMLElement | null): void
    /** Watch an element whose size can change above the reader; returns the unwatch. */
    watch(element: Element): () => void
    /** Note where the reader is now: after a scroll, a load or a hide. */
    remember(): void
    destroy(): void
}

/**
 * `blocks` lists the roll's blocks top to bottom; `sections` finds what sits between the tab's own
 * text and the roll, whose size changes move the roll: the Journal Panels and the backlinks.
 */
export function keepReadingPoint(
    blocks: () => Iterable<HTMLElement>,
    sections: (scroller: HTMLElement) => (HTMLElement | null)[],
): ReadingPointKeeper {
    let scroller: HTMLElement | null = null
    let mark: ReadingMark | null = null
    let watchedSections: HTMLElement[] = []
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => correct())

    const focusedText = () => document.activeElement?.closest('.cm-content') ?? null
    const holdsFocus = (block: HTMLElement) => {
        const text = focusedText()
        return text !== null && block.contains(text)
    }

    function blockMark(block: HTMLElement, top: number): ReadingMark {
        return {
            top,
            now: () => (block.isConnected ? block.getBoundingClientRect().top : null),
            focused: () => holdsFocus(block),
        }
    }

    /** The position in a day's text at the visible top, when its text crosses it. */
    function textMark(block: HTMLElement, visibleTop: number): ReadingMark | null {
        const element = block.querySelector<HTMLElement>('.cm-editor')
        const view = element ? EditorView.findFromDOM(element) : null
        if (!view) return null
        const content = view.contentDOM.getBoundingClientRect()
        if (content.top >= visibleTop || content.bottom <= visibleTop) return null
        // The END of the line at the top: text arriving is applied as the smallest change, and a
        // line written above shares its start ("- ") with the line it pushes down, so the change
        // begins after that line's start, which would stay put while its text moved away.
        const line = view.state.doc.lineAt(view.posAtCoords({ x: content.left + 1, y: visibleTop + 1 }, false))
        const anchor = { pos: line.to }
        const top = view.coordsAtPos(anchor.pos, -1)?.top
        if (top === undefined) return null
        anchors.set(view, anchor)
        return {
            top,
            now: () => (view.dom.isConnected ? (view.coordsAtPos(anchor.pos, -1)?.top ?? null) : null),
            focused: () => view.hasFocus,
        }
    }

    function remember(): void {
        mark = null
        if (!scroller) return
        const found = sections(scroller).filter((element): element is HTMLElement => element !== null)
        for (const element of watchedSections) if (!found.includes(element)) observer?.unobserve(element)
        for (const element of found) if (!watchedSections.includes(element)) observer?.observe(element)
        watchedSections = found
        const visibleTop = scroller.getBoundingClientRect().top
        // Still in the tab's own text: what changes size is below the reader.
        const ownText = scroller.querySelector<HTMLElement>(':scope > .cm-content')
        if (ownText && ownText.getBoundingClientRect().bottom > visibleTop + 1) return
        for (const block of blocks()) {
            const box = block.getBoundingClientRect()
            if (box.bottom <= visibleTop + 1) continue
            mark = (box.top < visibleTop - 1 && textMark(block, visibleTop)) || blockMark(block, box.top)
            return
        }
    }

    function correct(): void {
        const view = scroller
        const point = mark
        if (view && point && !point.focused()) {
            const now = point.now()
            if (now !== null && Math.abs(now - point.top) >= 0.5) view.scrollTop += now - point.top
        }
        remember()
    }

    // Remembered on every scroll, at once rather than on the next frame: a size change landing
    // before then would otherwise read the reader's own scroll as movement to undo.
    const onScroll = () => remember()

    return {
        setScroller(next) {
            scroller?.removeEventListener('scroll', onScroll)
            scroller = next
            scroller?.addEventListener('scroll', onScroll, { passive: true })
            remember()
        },
        watch(element) {
            observer?.observe(element)
            return () => observer?.unobserve(element)
        },
        remember,
        destroy() {
            scroller?.removeEventListener('scroll', onScroll)
            observer?.disconnect()
            scroller = null
            mark = null
        },
    }
}
