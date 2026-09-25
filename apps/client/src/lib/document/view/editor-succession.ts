/**
 * Editor succession: which `EditorView` took over from which, and which are gone for good.
 *
 * A DocumentView REMOUNTS its editor in a few situations - a [[Draft]] being promoted on its
 * first keystroke (ADR 0050), a document being protected or unprotected, a Draft superseded by a
 * page created elsewhere - and a remount is a new EditorView; the old one is destroyed. Anything
 * that captured the old view and dispatches into it later is ignored without a word: CodeMirror's
 * `update()` on a destroyed view stores the state and returns, painting nothing and reaching no
 * plugin - so no yCollab, so no CRDT.
 *
 * An asset upload is exactly that shape. The dialog captures the view, the bytes take a while,
 * and on a warm Server the promotion started by typing `/upload` finishes in between: the
 * reference was dispatched into the dead view, the asset was stored, and nothing referenced it.
 *
 * A remount records `previous → next` here with how to carry a position across: a promotion
 * SHIFTS it by the prefix the backend wrote ahead of the Draft's text (frontmatter on a
 * Filesystem Backend, nothing on a Server Backend); any other remount shows different text at
 * different offsets, so the position is CLAMPED into the new document's body instead. A teardown
 * with no remount - a closed tab, a mount that failed, a presenter re-keying the component - is a
 * dead end, marked so a late dispatcher can say so rather than write into nothing.
 */

import type { EditorView } from '@codemirror/view'

interface Hop {
    view: EditorView
    /** Added to a position from the previous view - the promoted body's offset. */
    shift: number
    /**
     * The first offset a position may land on in `view`: past any frontmatter block. Read when
     * a position is MAPPED, not when the hop is recorded: a Filesystem Backend mounts a document
     * over an empty buffer and fills it when the read lands, so at remount time there is no
     * block to see yet.
     */
    bodyStart: () => number
}

type Fate = { kind: 'succeeded'; hop: Hop } | { kind: 'torn-down' }

/** Weak on purpose: a destroyed view is kept alive only for as long as someone still holds it. */
const fates = new WeakMap<EditorView, Fate>()

/**
 * Record that `next` has replaced `previous`. `shift` is how far the text moved (a promotion's
 * body offset; zero for every other remount); `bodyStart` says where `next`'s body begins, asked
 * at mapping time. Overrides a torn-down mark, which the teardown inside a remount will have set
 * first.
 */
export function recordEditorSuccessor(
    previous: EditorView,
    next: EditorView,
    { shift = 0, bodyStart = () => 0 }: { shift?: number; bodyStart?: () => number } = {},
): void {
    if (previous === next) return
    fates.set(previous, { kind: 'succeeded', hop: { view: next, shift, bodyStart } })
}

/** Record that `view` was torn down with nothing taking its place (so far). */
export function markEditorTornDown(view: EditorView): void {
    fates.set(view, { kind: 'torn-down' })
}

export interface LiveEditorView {
    /** The view at the end of the chain - `view` itself when it was never replaced. */
    view: EditorView
    /** False when the chain ends on a torn-down view: nothing is showing this document any more. */
    alive: boolean
    /** Carry a position in the view asked about across every hop, clamped into the live document. */
    mapPos: (pos: number) => number
}

export function liveEditorView(view: EditorView): LiveEditorView {
    const hops: Hop[] = []
    const seen = new Set<EditorView>([view])
    let current = view
    let alive = true
    for (let fate = fates.get(current); fate; fate = fates.get(current)) {
        if (fate.kind === 'torn-down') {
            alive = false
            break
        }
        if (seen.has(fate.hop.view)) break
        seen.add(fate.hop.view)
        hops.push(fate.hop)
        current = fate.hop.view
    }
    return {
        view: current,
        alive,
        mapPos: (pos) => {
            let mapped = pos
            for (const hop of hops) {
                mapped = Math.min(Math.max(mapped + hop.shift, hop.bodyStart()), hop.view.state.doc.length)
            }
            return Math.min(Math.max(mapped, 0), current.state.doc.length)
        },
    }
}
